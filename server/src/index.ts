import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { checkDatabase, pool } from './db/index.js'

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
const app = createApp({
  checkDatabase, clientDirectory, recognitionDirectory, osmFile, hallTransformsFile, hallEditorOrigin,
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
  }, 10_000)
  timeout.unref()

  server.close((error) => {
    void (async () => {
      if (error) {
        throw error
      }
      await pool?.end()
      clearTimeout(timeout)
    })().catch((shutdownError: unknown) => {
      console.error('Server shutdown failed:', shutdownError)
      process.exitCode = 1
    })
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
