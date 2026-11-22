import { Router } from 'express'
import type { ErrorRequestHandler, Request } from 'express'
import type { AuthUser } from '../auth/repository.js'
import { ColourOrderConflictError } from './repository.js'
import type { ColourStore } from './repository.js'

export function coloursRouter(store: ColourStore, userFor: (req: Request) => AuthUser) {
  const router = Router()
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store').vary('Cookie')
    next()
  })
  router.use((req, res, next) => {
    if ([...new URL(req.originalUrl, 'http://localhost').searchParams].length) {
      console.warn('Rejected colour preference query parameters')
      res.status(400).json({ message: '颜色配置不接受查询参数' })
      return
    }
    next()
  })
  router.get('/', async (req, res) => {
    res.json({ colours: await store.list(userFor(req).id) })
  })
  router.put('/', async (req, res) => {
    const body: unknown = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !('colours' in body) || !Array.isArray(body.colours)
      || !body.colours.every((value: unknown) => typeof value === 'string' && /^#[\dA-F]{6}$/.test(value))
      || new Set(body.colours).size !== body.colours.length) {
      console.warn('Rejected invalid colour priority order')
      res.status(400).json({ message: 'colours 必须是不重复的大写六位十六进制颜色数组' })
      return
    }
    res.json({ colours: await store.reorder(userFor(req).id, body.colours) })
  })
  router.patch('/coefficient', async (req, res) => {
    const body: unknown = req.body
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 2
      || !('colour' in body) || typeof body.colour !== 'string' || !/^#[\dA-F]{6}$/.test(body.colour)
      || !('coefficient' in body) || typeof body.coefficient !== 'number' || !Number.isFinite(body.coefficient)
      || (body.coefficient !== 0 && (body.coefficient < 0.01 || body.coefficient > 1000))) {
      console.warn('Rejected invalid colour coefficient')
      res.status(400).json({ message: '颜色系数必须为 0 或 0.01 到 1000 之间的数字' })
      return
    }
    await store.setCoefficient(userFor(req).id, body.colour, body.coefficient)
    res.status(204).end()
  })
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent || res.destroyed) { next(error); return }
    console.error('Colour preferences request failed:', error)
    res.status(error instanceof ColourOrderConflictError ? 409 : 503)
      .json({ message: error instanceof ColourOrderConflictError ? error.message : '颜色配置读取或保存失败，请检查数据库迁移和服务端日志后重试' })
  }
  router.use(errors)
  return router
}
