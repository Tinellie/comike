import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { validHallTransforms } from './hallTransforms.js'
import type { CrawlerService } from './crawler/service.js'
import { crawlerRouter } from './crawler/routes.js'
import { boothRouter } from './booths/routes.js'
import type { BoothStore } from './booths/repository.js'
import type { AuthStore } from './auth/repository.js'
import { createAuth, sameOrigin } from './auth/routes.js'
import type { FavoritesService } from './favorites/service.js'
import { favoritesRouter } from './favorites/routes.js'
import type { ColourStore } from './colours/repository.js'
import { coloursRouter } from './colours/routes.js'
import { pixivRouter } from './social/pixiv/routes.js'
import type { PixivService } from './social/pixiv/service.js'
import type { TwitterService } from './social/twitter/service.js'
import { twitterRouter } from './social/twitter/routes.js'

const esriTiles = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'

export interface AppOptions {
  checkDatabase: () => Promise<void>
  clientDirectory?: string
  recognitionDirectory?: string
  osmFile?: string
  referenceOsmFile?: string
  hallTransformsFile?: string
  hallEditorOrigin?: string
  regeneratePreview?: () => Promise<void>
  crawler?: CrawlerService
  initializeDatabase?: () => Promise<void>
  authStore?: AuthStore
  secureCookie?: boolean
  trustProxy?: boolean
  boothStore?: BoothStore
  mediaRoot?: string
  favorites?: FavoritesService
  colourStore?: ColourStore
  pixiv?: PixivService
  twitter?: TwitterService
}

export function createApp({
  checkDatabase, clientDirectory, recognitionDirectory, osmFile, referenceOsmFile, hallTransformsFile, hallEditorOrigin,
  regeneratePreview,
  crawler, initializeDatabase, authStore, secureCookie, trustProxy,
  boothStore, mediaRoot, favorites, colourStore, pixiv, twitter,
}: AppOptions) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', trustProxy ? 1 : false)
  app.use(express.json())
  const auth = createAuth(authStore, secureCookie)
  const originCheck = sameOrigin(hallEditorOrigin)
  app.use('/api/auth', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') next()
    else originCheck(req, res, next)
  }, auth.router)
  app.use('/api/import', auth.requireUser, originCheck)
  if (favorites) app.use('/api/import', favoritesRouter(favorites, auth.userFor))
  app.use('/api/colours', auth.requireUser, originCheck)
  if (colourStore) app.use('/api/colours', coloursRouter(colourStore, auth.userFor))
  app.use('/api/social/pixiv', (req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/(?:booths|images)\//i.test(req.path)) next()
    else auth.requireUser(req, res, next)
  }, (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') next()
    else originCheck(req, res, next)
  })
  if (pixiv) app.use('/api/social/pixiv', pixivRouter(pixiv, auth.userFor))
  app.use('/api/social/twitter', (req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/(?:booths|images)\//i.test(req.path)) next()
    else auth.requireUser(req, res, next)
  }, (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') next()
    else originCheck(req, res, next)
  })
  if (twitter) app.use('/api/social/twitter', twitterRouter(twitter, auth.userFor))
  app.use('/api/preview', (req, res, next) => {
    // Map also uses the original PDF images; these read-only assets remain public.
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/page-\d{3}-pdf\.png$/.test(req.path)) next()
    else auth.requireAdmin(req, res, next)
  })
  app.use('/api/crawler', auth.requireAdmin)
  app.use('/api/map', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') next()
    else auth.requireAdmin(req, res, next)
  }, (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') next()
    else originCheck(req, res, next)
  })
  if (boothStore && mediaRoot) app.use('/api/booths', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') next()
    else auth.requireUser(req, res, next)
  }, (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') next()
    else originCheck(req, res, next)
  }, boothRouter(boothStore, mediaRoot, auth.currentUser))
  if (crawler && initializeDatabase) {
    app.use('/api/crawler', crawlerRouter(crawler, initializeDatabase, hallEditorOrigin))
  }

  let generation: { status: 'idle' | 'running' | 'succeeded' | 'failed'; message?: string } = { status: 'idle' }
  app.get('/api/preview/regenerate', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ...generation, enabled: Boolean(regeneratePreview) })
  })
  app.post('/api/preview/regenerate', (req, res) => {
    const origin = req.get('origin')
    if ((origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== hallEditorOrigin)
      || req.get('sec-fetch-site') === 'cross-site') {
      console.warn('Rejected cross-origin preview regeneration')
      res.status(403).json({ message: 'Cross-origin writes are not allowed' })
      return
    }
    if (!regeneratePreview) {
      res.status(503).json({ message: '此服务器未启用 PDF OCR，请在本地生成地图后上传，或使用完整 OCR 镜像' })
      return
    }
    if (generation.status === 'running') {
      res.status(409).json({ ...generation, message: 'PDF recognition is already running' })
      return
    }
    generation = { status: 'running' }
    void Promise.resolve().then(regeneratePreview).then(() => {
      generation = { status: 'succeeded' }
    }).catch((error: unknown) => {
      console.error('Preview regeneration failed:', error)
      generation = {
        status: 'failed',
        message: 'PDF 识别失败，请检查服务端日志和 Python 虚拟环境后重试。',
      }
    })
    res.status(202).json(generation)
  })

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/api/health/db', async (_req, res) => {
    try {
      await checkDatabase()
      res.json({ status: 'ok' })
    } catch (error) {
      console.error('Database health check failed:', error)
      res.status(503).json({ status: 'error', message: 'Database unavailable' })
    }
  })

  app.get(/^\/api\/preview\/(result\.json|page-\d{3}(?:(?:-pdf)?\.png|-paths\.json))$/, (req, res, next) => {
    const name = req.params[0]
    if (!recognitionDirectory || !name) {
      res.status(404).json({ message: 'Recognition output is not configured' })
      return
    }
    res.set('Cache-Control', 'no-store')
    res.sendFile(join(recognitionDirectory, name), (error) => {
      if (!error) return
      if (res.headersSent || res.destroyed) {
        next(error)
        return
      }
      if ('code' in error && error.code === 'ENOENT') {
        console.warn(`Recognition asset missing: ${name}`)
        res.status(404).json({ message: 'Recognition output not found. Run the recognition script first.' })
        return
      }
      next(error)
    })
  })

  app.get('/api/map/imagery/:zoom/:row/:col', async (req, res) => {
    const parts = [req.params.zoom, req.params.row, req.params.col] as const
    const [zoom, row, col] = [Number(parts[0]), Number(parts[1]), Number(parts[2])]
    if (!parts.every(value => /^\d{1,6}$/.test(value)) || zoom > 19 || row >= 2 ** zoom || col >= 2 ** zoom) {
      res.status(400).json({ message: '卫星瓦片坐标无效' })
      return
    }
    try {
      const upstream = await fetch(`${esriTiles}/${zoom}/${row}/${col}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      })
      if (!upstream.ok || upstream.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') {
        await upstream.body?.cancel()
        throw new Error(`Esri tile response: HTTP ${upstream.status}, ${upstream.headers.get('content-type')}`)
      }
      const image = Buffer.from(await upstream.arrayBuffer())
      const cacheControl = upstream.headers.get('cache-control')
      if (cacheControl) res.set('Cache-Control', cacheControl)
      res.type('image/jpeg').set('X-Content-Type-Options', 'nosniff').send(image)
    } catch (reason) {
      console.warn(`Esri imagery tile unavailable (${zoom}/${row}/${col}):`, reason)
      res.set('Cache-Control', 'no-store').status(502).json({ message: '卫星瓦片暂时无法加载' })
    }
  })

  app.get(/^\/api\/map\/(osm-map\.osm|ref\.osm)$/, (req, res, next) => {
    const name = req.params[0]
    const file = name === 'ref.osm' ? referenceOsmFile : osmFile
    if (!file) {
      res.status(404).json({ message: 'OSM map is not configured' })
      return
    }
    res.type('application/xml')
    res.sendFile(file, (error) => {
      if (!error) return
      if (res.headersSent || res.destroyed) {
        next(error)
        return
      }
      if ('code' in error && error.code === 'ENOENT') {
        console.warn('OSM map file missing:', file)
        res.status(404).type('json').json({ message: `OSM map not found. Add ref/${name} first.` })
        return
      }
      res.removeHeader('Content-Type')
      next(error)
    })
  })

  app.get(/^\/api\/map\/(final\.json|hall-transforms\.json)$/, (req, res, next) => {
    const file = req.params[0] === 'final.json'
      ? recognitionDirectory && join(recognitionDirectory, 'final.json')
      : hallTransformsFile
    if (!file) {
      res.status(404).json({ message: 'Hall data is not configured' })
      return
    }
    res.set('Cache-Control', 'no-store')
    res.sendFile(file, error => {
      if (!error) return
      if (res.headersSent || res.destroyed) {
        next(error)
        return
      }
      if ('code' in error && error.code === 'ENOENT') {
        console.warn('Hall asset missing:', file)
        res.status(404).json({ message: 'Hall data file not found' })
        return
      }
      next(error)
    })
  })

  app.put('/api/map/hall-transforms.json', async (req, res, next) => {
    if (!hallTransformsFile || !recognitionDirectory) {
      res.status(404).json({ message: 'Hall data is not configured' })
      return
    }
    const origin = req.get('origin')
    if ((origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== hallEditorOrigin)
      || req.get('sec-fetch-site') === 'cross-site') {
      console.warn('Rejected cross-origin Hall transform write')
      res.status(403).json({ message: 'Cross-origin writes are not allowed' })
      return
    }
    try {
      const final: { halls?: { name?: unknown }[] } = JSON.parse(
        await readFile(join(recognitionDirectory, 'final.json'), 'utf8'),
      )
      if (!Array.isArray(final.halls)) throw new Error('Invalid final Hall data')
      if (!validHallTransforms(req.body, final.halls.map(h => h.name))) {
        console.warn('Rejected invalid Hall transforms')
        res.status(400).json({ message: 'Invalid Hall transforms or mismatched final data' })
        return
      }
      const temporary = `${hallTransformsFile}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(req.body, null, 2) + '\n', 'utf8')
        await rename(temporary, hallTransformsFile)
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      res.json({ status: 'ok' })
    } catch (error) {
      next(error)
    }
  })

  app.use('/api', (_req, res) => {
    res.status(404).json({ message: 'API route not found' })
  })

  if (clientDirectory && existsSync(join(clientDirectory, 'index.html'))) {
    app.use(express.static(clientDirectory))
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
      res.sendFile(join(clientDirectory, 'index.html'))
    })
  }

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.destroyed) {
      console.warn('Request connection closed:', error)
      return
    }
    console.error('Request failed:', error)
    if (res.headersSent) {
      next(error)
      return
    }
    const status = error instanceof SyntaxError && 'body' in error ? 400 : 500
    res.status(status).json({
      message: status === 400 ? 'Invalid JSON body' : 'Internal server error',
    })
  }
  app.use(errorHandler)

  return app
}
