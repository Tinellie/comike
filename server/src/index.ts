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
  eventId => reconcileMapVacancies(resolve(recognitionDirectory, 'final.json'), eventId),
)
console.warn('Crawler dashboard has no authentication. Restrict network access before using real login sessions.')
const app = createApp({
  checkDatabase, clientDirectory, recognitionDirectory, osmFile, hallTransformsFile, hallEditorOrigin,
  regeneratePreview: () => regeneratePreview(fileURLToPath(new URL('../../', import.meta.url)), recognitionDirectory),
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
    await crawler.close()
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
