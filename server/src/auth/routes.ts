import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { Request, RequestHandler } from 'express'
import type { AuthStore, AuthUser } from './repository.js'
import { hashPassword, verifyPassword } from './password.js'

const cookieName = 'comike_session'
const lifetime = 7 * 24 * 60 * 60 * 1000
const dummyHash = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sessionToken(req: Request): string | undefined {
  const cookie = req.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  return cookie && /^[a-f0-9]{64}$/.test(cookie) ? cookie : undefined
}

export function sameOrigin(editorOrigin?: string): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('origin')
    if (req.get('sec-fetch-site') === 'cross-site'
      || (origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== editorOrigin)) {
      console.warn('Rejected cross-origin authenticated request')
      res.status(403).json({ message: '不允许跨站请求' })
      return
    }
    next()
  }
}

export function createAuth(store?: AuthStore, secureCookie = false) {
  async function currentUser(req: Request): Promise<AuthUser | null> {
    const token = sessionToken(req)
    if (!token) return null
    if (!store) throw new Error('Authentication database is not configured')
    return store.sessionUser(tokenHash(token))
  }

  const identities = new WeakMap<Request, AuthUser>()
  const requireUser: RequestHandler = async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    let user
    try { user = await currentUser(req) } catch (error) {
      console.error('Authentication unavailable:', error)
      res.status(503).json({ message: '认证服务不可用，请检查数据库配置和迁移' })
      return
    }
    if (!user) {
      console.warn('Rejected unauthenticated request:', req.method, req.path)
      res.status(401).json({ message: '请先登录' })
      return
    }
    identities.set(req, user)
    next()
  }

  function userFor(req: Request): AuthUser {
    const user = identities.get(req)
    if (!user) throw new Error('Authentication middleware is missing')
    return user
  }
  const requireAdmin: RequestHandler = (req, res, next) => {
    void requireUser(req, res, error => {
      if (error) { next(error); return }
      if (!userFor(req).isAdmin) {
        console.warn('Rejected administrator-only request:', req.method, req.path)
        res.status(403).json({ message: '仅管理员可访问' })
        return
      }
      next()
    })
  }
  const router = Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.get('/me', async (req, res) => {
    try { res.json({ user: await currentUser(req) }) } catch (error) {
      console.error('Session lookup failed:', error)
      res.status(503).json({ message: '认证服务不可用，请检查数据库配置和迁移' })
    }
  })

  // Bound both per-address retries and total concurrent password hashing work.
  const attempts = new Map<string, { count: number; reset: number }>()
  let hashing = 0
  const credentialsLimit: RequestHandler = (req, res, next) => {
    const now = Date.now()
    for (const [ip, entry] of attempts) if (entry.reset <= now) attempts.delete(ip)
    const ip = req.ip ?? 'unknown'
    const entry = attempts.get(ip) ?? { count: 0, reset: now + 15 * 60 * 1000 }
    if (entry.count >= 20 || hashing >= 4 || (!attempts.has(ip) && attempts.size >= 10000)) {
      res.set('Retry-After', '900').status(429).json({ message: '操作过于频繁，请稍后重试' })
      return
    }
    entry.count++
    attempts.set(ip, entry)
    next()
  }

  router.post(['/register', '/login'], credentialsLimit, async (req, res) => {
    const body: unknown = req.body
    if (!body || typeof body !== 'object'
      || !('username' in body) || typeof body.username !== 'string'
      || !/^[a-zA-Z0-9_]{3,32}$/.test(body.username)
      || !('password' in body) || typeof body.password !== 'string'
      || body.password.length < 8 || body.password.length > 128) {
      res.status(400).json({ message: '账号须为 3–32 位字母、数字或下划线；密码须为 8–128 位字符' })
      return
    }
    if (!store) {
      res.status(503).json({ message: '认证服务未配置，请配置数据库并执行迁移' })
      return
    }
    hashing++
    try {
      const username = body.username.toLowerCase()
      if (req.path === '/register') {
        const created = await store.createUser({
          id: randomUUID(), username, isAdmin: false, passwordHash: await hashPassword(body.password),
        })
        if (!created) {
          res.status(409).json({ message: '该账号已被注册' })
          return
        }
        res.status(201).json({ message: '注册成功，请登录' })
        return
      }
      const user = await store.findUser(username)
      const valid = await verifyPassword(body.password, user?.passwordHash ?? dummyHash)
      if (!user || !valid) {
        res.status(401).json({ message: '账号或密码错误' })
        return
      }
      const token = randomBytes(32).toString('hex')
      const oldToken = sessionToken(req)
      if (oldToken) await store.deleteSession(tokenHash(oldToken))
      await store.createSession(tokenHash(token), user.id, new Date(Date.now() + lifetime))
      res.cookie(cookieName, token, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/', maxAge: lifetime })
      res.json({ user: { id: user.id, username: user.username, isAdmin: user.isAdmin } })
    } catch (error) {
      console.error('Authentication request failed:', error)
      res.status(503).json({ message: '认证失败，请检查数据库配置和迁移后重试' })
    } finally {
      hashing--
    }
  })

  router.post('/logout', async (req, res) => {
    try {
      const token = sessionToken(req)
      if (token) {
        if (!store) throw new Error('Authentication database is not configured')
        await store.deleteSession(tokenHash(token))
      }
      res.clearCookie(cookieName, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/' })
      res.json({ user: null })
    } catch (error) {
      console.error('Logout failed:', error)
      res.status(503).json({ message: '退出失败，请稍后重试' })
    }
  })
  return { router, requireAdmin, requireUser, userFor, currentUser }
}
