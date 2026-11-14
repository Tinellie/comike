import { fileURLToPath } from 'node:url'
import { desc } from 'drizzle-orm'
import { db, pool } from '../db/index.js'
import { booths } from '../db/schema.js'
import { reconcileMapVacancies } from './reconcile.js'

try {
  if (!db) throw new Error('DATABASE_URL is not configured')
  const [latest] = await db.select({ eventId: booths.event_id }).from(booths).orderBy(desc(booths.comiket), desc(booths.event_id)).limit(1)
  const eventId = process.argv[2] ?? latest?.eventId
  if (!eventId || !/^\d{1,32}$/.test(eventId)) throw new Error('没有可比对的活动 ID')
  await reconcileMapVacancies(fileURLToPath(new URL('../../../tools/booth-recognition/output/official-map/final.json', import.meta.url)), eventId)
} catch (error) {
  console.error('Map vacancy reconciliation failed:', error)
  process.exitCode = 1
} finally {
  await pool?.end()
}
