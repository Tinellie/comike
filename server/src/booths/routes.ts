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
  router.patch('/:id/:kind', async (req, res) => {
    res.set('Cache-Control', 'private, no-store').vary('Cookie')
    try {
      const user = await currentUser(req)
      if (!user) { res.status(401).json({ message: '请先登录' }); return }
      if (!/^\d{1,32}$/.test(req.params.id)
        || [...new URL(req.originalUrl, 'http://localhost').searchParams].length) {
        console.warn('Rejected invalid booth edit parameters')
        res.status(400).json({ message: '编辑参数无效' }); return
      }
      const body: unknown = req.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        console.warn('Rejected invalid booth edit body')
        res.status(400).json({ message: '编辑内容无效' }); return
      }
      let result
      if (req.params.kind === 'favorite') {
        const keys = Object.keys(body)
        if (!keys.length || keys.some(key => key !== 'colour' && key !== 'memo')
          || ('colour' in body && body.colour !== null && (typeof body.colour !== 'string' || !/^#[\dA-F]{6}$/.test(body.colour)))
          || ('memo' in body && (typeof body.memo !== 'string' || Buffer.byteLength(body.memo, 'utf8') > 65535))) {
          console.warn('Rejected invalid favorite edit')
          res.status(400).json({ message: '颜色或 Memo 无效（Memo 最多 65535 UTF-8 字节）' }); return
        }
        const patch: { colour?: string | null; memo?: string } = {}
        if ('colour' in body && (typeof body.colour === 'string' || body.colour === null)) patch.colour = body.colour
        if ('memo' in body && typeof body.memo === 'string') patch.memo = body.memo
        result = await store.editFavorite(req.params.id, user.id, patch)
      } else if (req.params.kind === 'link') {
        if (!user.isAdmin) { console.warn('Rejected non-admin link edit'); res.status(403).json({ message: '仅管理员可修改 Links ID' }); return }
        if (Object.keys(body).length !== 2 || !('field' in body) || !('value' in body)
          || (body.field !== 'circle_id' && body.field !== 'pixiv_id' && body.field !== 'twitter_id')
          || (body.value !== null && (typeof body.value !== 'string'
            || !(body.field === 'twitter_id' ? /^[a-zA-Z0-9_]{1,15}$/ : /^\d{1,32}$/).test(body.value)))) {
          console.warn('Rejected invalid link ID')
          res.status(400).json({ message: '请填写有效的账号 ID，而非完整链接；留空可清除' }); return
        }
        result = await store.editLink(req.params.id, body.field, body.value)
      } else { res.status(404).json({ message: '编辑接口不存在' }); return }
      if (!result) res.status(404).json({ message: '社团不存在' })
      else res.json(result)
    } catch (error) {
      console.error('Booth edit failed:', error)
      res.status(error instanceof BoothFilterError ? 400 : 503)
        .json({ message: error instanceof BoothFilterError ? error.message : '保存失败，请检查数据库迁移和服务端日志后重试' })
    }
  })
  router.get('/map-favorites', async (req, res) => {
    res.set('Cache-Control', 'private, no-store').vary('Cookie')
    const params = new URL(req.originalUrl, 'http://localhost').searchParams
    const eventId = params.get('eventId') ?? '', weekday = params.get('weekday') ?? ''
    if ([...params.keys()].some(key => !['eventId', 'weekday'].includes(key) || params.getAll(key).length !== 1)
      || !/^\d{1,32}$/.test(eventId) || !/^[月火水木金土日]$/.test(weekday)) {
      console.warn('Rejected invalid personal map favorites query')
      res.status(400).json({ message: '收藏地图参数无效' })
      return
    }
    try {
      const user = await currentUser(req)
      if (!user) {
        console.warn('Rejected unauthenticated map favorites request')
        res.status(401).json({ message: '请先登录' })
        return
      }
      res.json({ favorites: await store.mapFavorites(eventId, weekday, user.id) })
    } catch (error) {
      console.error('Personal map favorites unavailable:', error)
      res.status(503).json({ message: '收藏摊位位置读取失败，请检查数据库和服务端日志后重试' })
    }
  })
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
    if (req.path === '/options') res.set('Cache-Control', 'private, no-store').vary('Cookie')
    const params = new URL(req.originalUrl, 'http://localhost').searchParams
    const eventId = params.get('eventId') ?? undefined
    if ([...params.keys()].some(key => key !== 'eventId') || params.getAll('eventId').length > 1
      || (eventId !== undefined && !/^\d{1,32}$/.test(eventId))) {
      console.warn('Rejected invalid booth options query')
      res.status(400).json({ message: '活动 ID 参数无效' })
      return
    }
    try {
      const options = await (req.path === '/days' ? store.days(eventId) : store.options(eventId, (await currentUser(req))?.id))
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
    res.set('Cache-Control', 'private, no-store').vary('Cookie')
    if (!/^\d{1,32}$/.test(req.params.id)) {
      console.warn('Rejected invalid booth ID')
      res.status(400).json({ message: '详情 ID 无效' })
      return
    }
    try {
      const result = await store.detail(req.params.id, (await currentUser(req))?.id)
      if (!result) res.status(404).json({ message: '社团详情不存在' })
      else res.json(result)
    } catch (error) {
      console.error('Booth detail unavailable:', error)
      res.status(503).json({ message: '无法读取社团详情，请检查数据库和服务端日志' })
    }
  })
  return router
}
