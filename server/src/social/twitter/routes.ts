import { Router } from 'express'
import type { ErrorRequestHandler, Request } from 'express'
import { join } from 'node:path'
import type { AuthUser } from '../../auth/repository.js'
import { validPixivId } from '../pixiv/source.js'
import { PixivConflictError } from '../pixiv/service.js'
import type { TwitterService } from './service.js'
import { ImageTokenError } from '../liveImages.js'

export function twitterRouter(service: TwitterService, userFor: (request: Request) => AuthUser) {
  const router = Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.get('/status', (req, res) => {
    res.set('Cache-Control', 'private, no-store').vary('Cookie')
    res.json(service.status(userFor(req).id))
  })
  router.post('/start', (req, res) => {
    const body: unknown = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('mode' in body)
      || !['refresh', 'missing'].includes(String(body.mode))
      || Object.keys(body).some(key => key !== 'mode') || Object.keys(req.query).length) {
      console.warn('Rejected invalid Twitter image job')
      res.status(400).json({ message: '图片任务参数无效' }); return
    }
    service.start(userFor(req).id, body.mode === 'missing')
    res.status(202).json(service.status(userFor(req).id))
  })
  router.get('/live/booths/:id', async (req, res) => {
    res.set('Cache-Control', 'private, no-store').vary('Cookie')
    if (!/^\d{1,32}$/.test(req.params.id)) {
      console.warn('Rejected invalid live Twitter booth ID')
      res.status(400).json({ message: '社团 ID 无效' }); return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    res.once('close', cancel)
    try {
      const gallery = await service.liveGallery(req.params.id, controller.signal)
      if (res.destroyed) return
      if (!gallery) res.status(404).json({ message: '社团不存在' })
      else res.json(gallery)
    } finally { res.off('close', cancel) }
  })
  router.get('/live/images/:token', async (req, res) => {
    const image = await service.liveImage(req.params.token)
    if (res.destroyed) return
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).vary('Cookie')
    res.type(image.extension).send(image.body)
  })
  router.get('/booths/:id', async (req, res) => {
    if (!/^\d{1,32}$/.test(req.params.id)) {
      console.warn('Rejected invalid Twitter booth ID')
      res.status(400).json({ message: '社团 ID 无效' }); return
    }
    const gallery = await service.gallery(req.params.id)
    if (!gallery) res.status(404).json({ message: '社团不存在' })
    else res.json(gallery)
  })
  router.get('/images/:id/:name', (req, res, next) => {
    if (!validPixivId(req.params.id) || !/^[1-9]\d{0,31}\.(png|jpe?g|gif|webp)$/i.test(req.params.name)) {
      console.warn('Rejected invalid Twitter image path')
      res.status(400).json({ message: '图片路径无效' }); return
    }
    res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    res.sendFile(join(service.storage.directory(req.params.id), req.params.name), error => {
      if (!error) return
      if (!res.headersSent && !res.destroyed && 'code' in error && error.code === 'ENOENT') {
        console.warn('Twitter cached image missing')
        res.status(404).json({ message: '图片不存在' })
      } else next(error)
    })
  })
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent || res.destroyed) { next(error); return }
    console.error('Twitter image request failed:', error)
    res.status(error instanceof PixivConflictError ? 409 : error instanceof ImageTokenError ? 400 : 503)
      .json({ message: error instanceof PixivConflictError || error instanceof ImageTokenError ? error.message : 'Twitter 图片服务不可用，请检查服务端日志' })
  }
  router.use(errors)
  return router
}
