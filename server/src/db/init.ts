import { initializeDatabase } from './initialize.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('Set DATABASE_URL before initializing the database')
await initializeDatabase(url)
console.info('Database initialized and migrations applied')
