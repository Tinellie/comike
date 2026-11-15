import { Router } from 'express'
import type { Request } from 'express'
import { join } from 'node:path'
import { BoothFilterError, parseBoothQuery } from './catalog.js'
import type { BoothStore } from './repository.js'
import type { AuthUser } from '../auth/repository.js'

export function boothRouter(store: BoothStore, mediaRoot: string,
  currentUser: (req: Request) => Promise<AuthUser | null> = async () => null) {
  const router = Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.get('/map-data', async (req, res) => {
    const params = new URL(req.originalUrl, 'http://localhost').searchParams
    const eventId = params.get('eventId') ?? '', weekday = params.get('weekday') ?? ''
    if ([...params.keys()].some(key => !['eventId', 'weekday'].includes(key) || params.getAll(key).length !== 1)
      || !/^\d{1,32}$/.test(eventId) || !/^[月火水木金土日]$/.test(weekday)) {
      console.warn('Rejected invalid map preload query')
      res.status(400).json({ message: '地图预加载参数无效' })
      return
    }
    try {
      res.json(await store.mapData(eventId, weekday))
    } catch (error) {
      console.error('Map booth preload failed:', error)
      res.status(503).json({ message: '地图摊位预加载失败，请检查数据库和服务端日志' })
    }
  })
  router.get('/location', async (req, res) => {
    const params = new URL(req.originalUrl, 'http://localhost').searchParams
    const eventId = params.get('eventId') ?? '', weekday = params.get('weekday') ?? ''
    const hallGroup = params.get('hallGroup') ?? '', island = params.get('island') ?? ''
    const number = params.get('number') ?? '', suffix = params.get('suffix')
    if ([...params.keys()].some(key => !['eventId', 'weekday', 'hallGroup', 'island', 'number', 'suffix'].includes(key) || params.getAll(key).length !== 1)
      || !/^\d{1,32}$/.test(eventId) || !/^[月火水木金土日]$/.test(weekday) || !/^[東西南北]\d+$/.test(hallGroup)
      || !island || island.length > 32 || !/^\d{1,2}$/.test(number) || (suffix !== 'a' && suffix !== 'b')) {
      console.warn('Rejected invalid map booth location')
      res.status(400).json({ message: '地图位置参数无效' })
      return
    }
    try {
      const result = await store.atLocation({ eventId, weekday, hallGroup, island, number, suffix })
      if (!result) res.status(404).json({ message: '活动不存在' })
      else res.json(result)
    } catch (error) {
      console.error('Map booth lookup failed:', error)
      res.status(error instanceof BoothFilterError ? 400 : 503).json({ message: error instanceof BoothFilterError ? error.message : '地图社团信息读取失败，请检查数据库迁移及日志' })
    }
  })
  router.get(['/options', '/days'], async (req, res) => {
    const params = new URL(req.originalUrl, 'http://localhost').searchParams
    const eventId = params.get('eventId') ?? undefined
    if ([...params.keys()].some(key => key !== 'eventId') || params.getAll('eventId').length > 1
      || (eventId !== undefined && !/^\d{1,32}$/.test(eventId))) {
      console.warn('Rejected invalid booth options query')
      res.status(400).json({ message: '活动 ID 参数无效' })
      return
    }
    try {
      const options = await (req.path === '/days' ? store.days(eventId) : store.options(eventId))
      if (!options) res.status(404).json({ message: '活动不存在' })
      else res.json(options)
    } catch (error) {
      console.error('Booth filter options unavailable:', error)
      res.status(503).json({ message: '无法读取筛选项，请检查数据库迁移和地图识别数据' })
    }
  })
  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'private, no-store').vary('Cookie')
    let query
    try { query = parseBoothQuery(new URL(req.originalUrl, 'http://localhost').searchParams) } catch (error) {
      console.warn('Rejected invalid booth list query:', error)
      res.status(400).json({ message: error instanceof Error ? error.message : '列表查询无效' })
      return
    }
    try {
      const user = await currentUser(req)
      const result = await store.list(query, user?.id)
      if (!result) res.status(404).json({ message: '活动不存在' })
      else res.json(result)
    } catch (error) {
      if (error instanceof BoothFilterError) {
        console.warn('Rejected unavailable booth filter:', error.message)
        res.status(400).json({ message: error.message })
        return
      }
      console.error('Booth list unavailable:', error)
      res.status(503).json({ message: '无法读取社团列表，请检查数据库迁移、筛选条件及服务端日志' })
    }
  })
  router.get('/images/:edition/:name', (req, res, next) => {
    if (!/^c[1-9]\d*$/.test(req.params.edition) || !/^\d+_[1-9]\d*\.(png|jpe?g|gif|webp)$/i.test(req.params.name)) {
      console.warn('Rejected invalid booth image path')
      res.status(400).json({ message: '图片路径无效' })
      return
    }
    res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    res.sendFile(join(mediaRoot, 'booths', req.params.edition, req.params.name), error => {
      if (!error) return
      if (res.headersSent || res.destroyed) { next(error); return }
      if ('code' in error && error.code === 'ENOENT') {
        console.warn('Booth image missing:', req.params.name)
        res.status(404).json({ message: '图片不存在' })
      } else next(error)
    })
  })
  router.get('/:id', async (req, res) => {
    if (!/^\d{1,32}$/.test(req.params.id)) {
      console.warn('Rejected invalid booth ID')
      res.status(400).json({ message: '详情 ID 无效' })
      return
    }
    try {
      const result = await store.detail(req.params.id)
      if (!result) res.status(404).json({ message: '社团详情不存在' })
      else res.json(result)
    } catch (error) {
      console.error('Booth detail unavailable:', error)
      res.status(503).json({ message: '无法读取社团详情，请检查数据库和服务端日志' })
    }
  })
  return router
}
