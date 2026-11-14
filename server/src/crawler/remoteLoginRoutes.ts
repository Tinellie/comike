import { Router } from 'express'
import type { Request } from 'express'
import type { BrowserInput, LoginSession } from './login.js'
import { LoginRequiredError } from './parser.js'

export function parseBrowserInput(body: unknown): BrowserInput {
  if (!body || typeof body !== 'object' || !('type' in body)) throw new Error('Invalid browser input')
  if (body.type === 'click' && 'x' in body && 'y' in body
    && typeof body.x === 'number' && typeof body.y === 'number'
    && Number.isFinite(body.x) && Number.isFinite(body.y)
    && body.x >= 0 && body.x < 1280 && body.y >= 0 && body.y < 800) {
    return { type: 'click', x: body.x, y: body.y }
  }
  if (body.type === 'text' && 'text' in body && typeof body.text === 'string'
    && body.text.length > 0 && body.text.length <= 2048) return { type: 'text', text: body.text }
  if (body.type === 'key' && 'key' in body && typeof body.key === 'string'
    && /^(?:(?:Control|Shift|Alt|Meta)\+)*(?:[a-zA-Z0-9]|Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(body.key)) {
    return { type: 'key', key: body.key }
  }
  if (body.type === 'wheel' && 'deltaY' in body && typeof body.deltaY === 'number'
    && Number.isFinite(body.deltaY) && Math.abs(body.deltaY) <= 2000) return { type: 'wheel', deltaY: body.deltaY }
  throw new Error('Invalid browser input')
}

type Controls = Pick<LoginSession, 'status' | 'open' | 'confirm' | 'screenshot' | 'input'>

export function remoteLoginRouter(controls: (req: Request) => Controls) {
  const router = Router()
  router.get('/status', (req, res) => { res.json(controls(req).status()) })
  router.post('/open', async (req, res) => {
    await controls(req).open()
    res.json(controls(req).status())
  })
  router.post('/confirm', async (req, res, next) => {
    try { await controls(req).confirm(); res.json(controls(req).status()) } catch (error) {
      if (error instanceof LoginRequiredError) res.status(409).json({ message: error.message })
      else next(error)
    }
  })
  router.get('/screenshot', async (req, res, next) => {
    const login = controls(req)
    const status = login.status()
    if (status.opening) { res.status(202).end(); return }
    if (!status.open) {
      res.status(409).json({ message: status.error ?? '登录窗口已关闭，请重新打开登录窗口', authenticated: status.authenticated })
      return
    }
    try { res.type('image/jpeg').send(await login.screenshot()) } catch (error) {
      const current = login.status()
      if (!current.open || current.authenticated) {
        console.info('Login screenshot cancelled because the login window closed')
        res.status(409).json({ message: '登录窗口已关闭', authenticated: current.authenticated })
      } else next(error)
    }
  })
  router.post('/input', async (req, res) => {
    let input: BrowserInput
    try { input = parseBrowserInput(req.body) } catch {
      console.warn('Rejected invalid remote browser input')
      res.status(400).json({ message: '无效的浏览器输入' })
      return
    }
    await controls(req).input(input)
    res.sendStatus(204)
  })
  return router
}
