import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { validHallTransforms } from './hallTransforms.js'

interface AppOptions {
  checkDatabase: () => Promise<void>
  clientDirectory?: string
  recognitionDirectory?: string
  osmFile?: string
  hallTransformsFile?: string
  hallEditorOrigin?: string
}

export function createApp({
  checkDatabase, clientDirectory, recognitionDirectory, osmFile, hallTransformsFile, hallEditorOrigin,
}: AppOptions) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())

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

  app.get(/^\/api\/preview\/(result\.json|page-\d{3}(?:-pdf)?\.png)$/, (req, res, next) => {
    const name = req.params[0]
    if (!recognitionDirectory || !name) {
      res.status(404).json({ message: 'Recognition output is not configured' })
      return
    }
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

  app.get('/api/map/osm-map.osm', (_req, res, next) => {
    if (!osmFile) {
      res.status(404).json({ message: 'OSM map is not configured' })
      return
    }
    res.type('application/xml')
    res.sendFile(osmFile, (error) => {
      if (!error) return
      if (res.headersSent || res.destroyed) {
        next(error)
        return
      }
      if ('code' in error && error.code === 'ENOENT') {
        console.warn('OSM map file missing:', osmFile)
        res.status(404).type('json').json({ message: 'OSM map not found. Add ref/osm-map.osm first.' })
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
