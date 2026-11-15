import { Router } from 'express'
import type { ErrorRequestHandler, Request } from 'express'
import type { AuthUser } from '../auth/repository.js'
import { remoteLoginRouter } from '../crawler/remoteLoginRoutes.js'
import { FavoritesService, ImportConflictError } from './service.js'

export function favoritesRouter(service: FavoritesService, userFor: (req: Request) => AuthUser) {
  const router = Router()
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
    next()
  })
  router.get('/status', async (req, res) => { res.json(await service.status(userFor(req).id)) })
  router.post('/start', (req, res) => {
    service.start(userFor(req).id)
    res.status(202).json({ message: '已开始导入，请登录自己的 Circle.ms 账号' })
  })
  router.post('/stop', (req, res) => {
    service.stop(userFor(req).id)
    res.status(202).json({ message: '正在停止并退出 Circle.ms' })
  })
  router.use('/login', remoteLoginRouter(req => {
    const id = userFor(req).id
    return {
      status: () => service.loginStatus(id),
      open: () => service.openLogin(id),
      confirm: () => service.confirmLogin(id),
      screenshot: () => service.screenshot(id),
      input: input => service.input(id, input),
    }
  }))
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent || res.destroyed) { next(error); return }
    console.error('Favorites request failed:', error)
    res.status(error instanceof ImportConflictError ? 409 : 503)
      .json({ message: error instanceof ImportConflictError ? error.message : '导入服务不可用，请检查数据库迁移、浏览器及服务端日志后重试' })
  }
  router.use(errors)
  return router
}
