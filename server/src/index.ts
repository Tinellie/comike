import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { checkDatabase, pool } from './db/index.js'
import { regeneratePreview } from './regeneratePreview.js'
import { resolve } from 'node:path'
import { RemoteLogin } from './crawler/login.js'
import { CrawlerService } from './crawler/service.js'
import { MysqlJobRepository } from './crawler/repository.js'
import { initializeDatabase } from './db/initialize.js'
import { createHallGroupsLoader } from './booths/catalog.js'
import { MysqlBoothRepository } from './booths/repository.js'
import { reconcileMapVacancies } from './booths/reconcile.js'
import { organizeMapGenres } from './booths/genres.js'
import { MapOrganization } from './booths/organization.js'
import { MysqlAuthStore } from './auth/repository.js'
import { FavoritesService } from './favorites/service.js'
import { MysqlFavoritesStore } from './favorites/repository.js'
import { favoritesUrl } from './favorites/parser.js'
import { MysqlColourStore } from './colours/repository.js'
import { MysqlPixivStore } from './social/pixiv/repository.js'
import { PixivAppSource, pixivAppOptions } from './social/pixiv/appSource.js'
import { PixivStorage } from './social/pixiv/storage.js'
import { PixivService } from './social/pixiv/service.js'
import { MysqlTwitterStore } from './social/twitter/repository.js'
import { RettiwtSource } from './social/twitter/source.js'
import { TwitterService } from './social/twitter/service.js'

const port = Number(process.env.PORT ?? 3001)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}

if (!pool) {
  console.warn('DATABASE_URL is not configured; database access is disabled')
}

const clientDirectory = fileURLToPath(new URL('../../client/dist/', import.meta.url))
const recognitionDirectory = fileURLToPath(
  new URL('../../tools/booth-recognition/output/official-map/', import.meta.url),
)
const osmFile = fileURLToPath(new URL('../../ref/osm-map.osm', import.meta.url))
const hallTransformsFile = fileURLToPath(new URL('../../ref/hall-transforms.json', import.meta.url))
const hallEditorOrigin = process.env.HALL_EDITOR_ORIGIN ?? 'http://localhost:5173'
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const privateRoot = resolve(projectRoot, process.env.CRAWLER_STATE_DIR ?? '.local/crawler')
const crawler = new CrawlerService(
  new RemoteLogin(resolve(privateRoot, 'auth.json')),
  new MysqlJobRepository(),
  resolve(projectRoot, process.env.MEDIA_ROOT ?? 'storage'),
  resolve(privateRoot, 'work'),
  undefined,
  async eventId => {
    const file = resolve(recognitionDirectory, 'final.json')
    await reconcileMapVacancies(file, eventId)
    await organizeMapGenres(file, eventId)
  },
  new MapOrganization(resolve(recognitionDirectory, 'final.json')),
)
const favorites = new FavoritesService(new MysqlFavoritesStore(),
  () => new RemoteLogin(undefined, undefined, favoritesUrl, 'table.t-user-favorites'))
const pixiv = new PixivService(new MysqlPixivStore(), new PixivAppSource(pixivAppOptions()),
  new PixivStorage(resolve(projectRoot, process.env.MEDIA_ROOT ?? 'storage')))
const twitter = new TwitterService(new MysqlTwitterStore(), new RettiwtSource({
  apiKey: process.env.TWITTER_API_KEY, proxyUrl: process.env.TWITTER_PROXY_URL,
}), new PixivStorage(resolve(projectRoot, process.env.MEDIA_ROOT ?? 'storage'), 'twitter'))
const app = createApp({
  pixiv, twitter,
  colourStore: new MysqlColourStore(),
  favorites,
  authStore: new MysqlAuthStore(),
  secureCookie: process.env.NODE_ENV === 'production' || process.env.AUTH_COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  checkDatabase, clientDirectory, recognitionDirectory, osmFile, hallTransformsFile, hallEditorOrigin,
  ...(process.env.OCR_ENABLED !== 'false' ? {
    regeneratePreview: () => regeneratePreview(fileURLToPath(new URL('../../', import.meta.url)), recognitionDirectory),
  } : {}),
  crawler,
  boothStore: new MysqlBoothRepository(createHallGroupsLoader(resolve(recognitionDirectory, 'final.json'))),
  mediaRoot: resolve(projectRoot, process.env.MEDIA_ROOT ?? 'storage'),
  initializeDatabase: async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured')
    await initializeDatabase(process.env.DATABASE_URL)
  },
})
const server = app.listen(port, () => {
  console.info(`Server listening on http://localhost:${port}`)
})

server.on('error', (error) => {
  console.error('Server failed:', error)
  process.exit(1)
})

function shutdown() {
  const timeout = setTimeout(() => {
    console.error('Server shutdown timed out')
    process.exit(1)
  }, 60_000)
  timeout.unref()

  void (async () => {
    await Promise.all([crawler.close(), favorites.close(), pixiv.close(), twitter.close()])
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    await pool?.end()
    clearTimeout(timeout)
  })().catch((error: unknown) => {
    console.error('Server shutdown failed:', error)
    process.exitCode = 1
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
