import { Router } from 'express'
import { CrawlerConflictError } from './service.js'
import type { CrawlerService } from './service.js'
import { remoteLoginRouter } from './remoteLoginRoutes.js'
export { parseBrowserInput } from './remoteLoginRoutes.js'

export function crawlerRouter(
  service: CrawlerService,
  initialize: () => Promise<void>,
  editorOrigin: string | undefined,
) {
  const router = Router()
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
    const origin = req.get('origin')
    if (req.get('sec-fetch-site') === 'cross-site'
      || (origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== editorOrigin)) {
      console.warn('Rejected cross-origin crawler access')
      res.status(403).json({ message: 'Cross-origin crawler access is not allowed' })
      return
    }
    next()
  })
  router.get('/status', async (_req, res) => {
    try { res.json(await service.status()) } catch (error) {
      console.error('Crawler status unavailable:', error)
      res.status(503).json({ message: '数据库不可用或表未创建，请配置 DATABASE_URL 并初始化数据库' })
    }
  })
  router.post('/initialize', async (_req, res) => {
    try {
      await initialize()
      res.json({ message: '数据库已创建，迁移已应用' })
    } catch (error) {
      console.error('Database initialization failed:', error)
      res.status(503).json({ message: '初始化失败，请检查 DATABASE_URL、MySQL 服务和建库权限；详情见服务端日志' })
    }
  })
  router.get('/organization', async (_req, res) => {
    try { res.json(await service.organizationStatus()) } catch (error) {
      console.error('Map organization status unavailable:', error)
      res.status(503).json({ message: '地图整理状态读取失败，请检查数据库迁移和服务端日志' })
    }
  })
  router.post('/organize', async (req, res) => {
    const kind: unknown = req.body?.kind
    if (kind !== 'vacancies' && kind !== 'genres') {
      console.warn('Rejected invalid map organization kind')
      res.status(400).json({ message: '无效的地图整理类型' })
      return
    }
    try {
      const result = await service.organize(kind)
      res.json({ result, message: kind === 'vacancies' ? 'vacancies 及合并范围已整理' : 'genre 范围、颜色、代码和数量已整理' })
    } catch (error) {
      if (error instanceof CrawlerConflictError) res.status(409).json({ message: error.message })
      else {
        console.error('Map organization failed:', error)
        res.status(503).json({ message: error instanceof Error ? `整理失败：${error.message}` : '地图整理失败，请检查服务端日志' })
      }
    }
  })
  router.post('/start', async (req, res) => {
    if ((req.body?.resume !== undefined && typeof req.body.resume !== 'boolean')
      || (req.body?.refreshList !== undefined && typeof req.body.refreshList !== 'boolean')) {
      console.warn('Rejected invalid crawler start input')
      res.status(400).json({ message: 'resume and refreshList must be booleans' })
      return
    }
    try {
      await service.start(req.body?.resume === true, req.body?.refreshList === true)
      res.status(202).json(await service.status())
    } catch (error) {
      if (error instanceof CrawlerConflictError) res.status(409).json({ message: error.message })
      else {
        console.error('Unable to start crawler:', error)
        res.status(503).json({ message: '无法启动采集，请检查数据库配置和服务端日志' })
      }
    }
  })
  router.post('/stop', async (_req, res, next) => {
    try { await service.stop(); res.status(202).json({ message: '正在停止' }) } catch (error) {
      if (error instanceof CrawlerConflictError) res.status(409).json({ message: error.message })
      else next(error)
    }
  })
  router.post('/reset', async (req, res) => {
    if (req.body?.confirmation !== '清空') {
      console.warn('Rejected crawler reset without explicit confirmation')
      res.status(400).json({ message: '请输入“清空”确认删除 booth 数据和图片' })
      return
    }
    try {
      const result = await service.reset()
      res.json({
        ...result,
        message: `已清空 ${result.deletedBooths} 条 booth 数据、任务进度及 ${result.deletedImages} 个图片文件；列表缓存和登录会话已保留，可点击“开始采集”重新读取详情`,
      })
    } catch (error) {
      if (error instanceof CrawlerConflictError) res.status(409).json({ message: error.message })
      else {
        console.error('Crawler data reset failed:', error)
        res.status(503).json({ message: '清空未完成：请检查数据库权限、图片目录及服务端日志。部分数据可能已清空，排除问题后可重试' })
      }
    }
  })
  router.post('/login/open', async (_req, res) => {
    try { await service.login.open(); res.json(service.login.status()) } catch (error) {
      console.error('Remote login unavailable:', error)
      res.status(503).json({ message: '无法打开登录浏览器，请检查网络及 Playwright Chromium 安装；可在登录窗口中重试' })
    }
  })
  router.post('/login/clear', async (_req, res, next) => {
    try {
      if (service.active) {
        res.status(409).json({ message: '请先停止采集任务，再清除会话' })
        return
      }
      await service.login.clear()
      res.json(service.login.status())
    } catch (error) { next(error) }
  })
  router.use('/login', remoteLoginRouter(() => service.login))
  return router
}
