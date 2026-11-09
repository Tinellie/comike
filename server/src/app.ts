import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

interface AppOptions {
  checkDatabase: () => Promise<void>
  clientDirectory?: string
}

export function createApp({ checkDatabase, clientDirectory }: AppOptions) {
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
