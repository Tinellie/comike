import { eq, isNull } from 'drizzle-orm'
import { db, pool } from '../db/index.js'
import { booths } from '../db/schema.js'
import { nameReading } from './reading.js'

try {
  if (!db) throw new Error('DATABASE_URL is not configured')
  let updated = 0
  const readings = new Map<string, string>()
  while (true) {
    const rows = await db.select({ id: booths.id, name: booths.circle_name }).from(booths)
      .where(isNull(booths.circle_name_reading)).limit(200)
    if (!rows.length) break
    for (const row of rows) {
      let reading = readings.get(row.name)
      if (reading === undefined) {
        reading = await nameReading(row.name)
        readings.set(row.name, reading)
      }
      await db.update(booths).set({ circle_name_reading: reading }).where(eq(booths.id, row.id))
      updated++
    }
    console.info(`Generated circle name readings: ${updated}`)
  }
  console.info(`Circle name readings ready; updated ${updated} records`)
} catch (error) {
  console.error('Circle name reading generation failed:', error)
  process.exitCode = 1
} finally {
  await pool?.end()
}
