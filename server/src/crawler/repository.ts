import { desc, eq, inArray, sql } from 'drizzle-orm'
import { db, checkDatabase } from '../db/index.js'
import { booths, circleListCache, crawlJobs, mapVacancies, mapVacancyRegions, mapGenres, mapGenreRegions } from '../db/schema.js'
import type { Booth } from '../db/schema.js'
import type { CircleListCache, CrawlJob, JobRepository } from './types.js'
import { nameReading } from '../booths/reading.js'

function database() {
  if (!db) throw new Error('DATABASE_URL is not configured; run db:init before crawling')
  return db
}

export class MysqlJobRepository implements JobRepository {
  async check() {
    await checkDatabase()
    await database().select({ id: booths.id }).from(booths).limit(1)
    await database().select({ id: crawlJobs.id }).from(crawlJobs).limit(1)
    await database().select({ id: circleListCache.id }).from(circleListCache).limit(1)
  }

  async load(): Promise<CrawlJob | null> {
    const [row] = await database().select().from(crawlJobs).orderBy(desc(crawlJobs.updated_at)).limit(1)
    if (!row) return null
    const job: CrawlJob = JSON.parse(row.state)
    if (!job.id || !Array.isArray(job.ids) || !Array.isArray(job.completedIds) || !job.failures) {
      throw new Error('Invalid persisted crawler job')
    }
    return job
  }

  async save(job: CrawlJob) {
    const value = { id: job.id, state: JSON.stringify(job), updated_at: new Date(job.updatedAt) }
    await database().insert(crawlJobs).values(value).onDuplicateKeyUpdate({ set: value })
  }

  async saveBooth(booth: Booth) {
    booth.circle_name_reading = await nameReading(booth.circle_name)
    await database().insert(booths).values(booth).onDuplicateKeyUpdate({ set: booth })
  }

  async resetRecords() {
    return database().transaction(async transaction => {
      const [deleted] = await transaction.delete(booths)
      await transaction.delete(mapVacancies)
      await transaction.delete(mapVacancyRegions)
      await transaction.delete(mapGenreRegions)
      await transaction.delete(mapGenres)
      await transaction.delete(crawlJobs)
      return deleted.affectedRows
    })
  }

  async loadList(): Promise<CircleListCache | null> {
    const [row] = await database().select().from(circleListCache).where(eq(circleListCache.id, 'syllabary')).limit(1)
    if (row) {
      const cache: CircleListCache = JSON.parse(row.state)
      this.validateList(cache)
      return cache
    }
    const [previous] = await database().select().from(crawlJobs)
      .where(sql`JSON_EXTRACT(${crawlJobs.state}, '$.listComplete') = true`)
      .orderBy(desc(crawlJobs.updated_at)).limit(1)
    if (!previous) return null
    const job: CrawlJob = JSON.parse(previous.state)
    const cache = { ids: job.ids, eventId: job.eventId, comiket: job.comiket, completedAt: job.updatedAt }
    await this.saveList(cache)
    return cache
  }

  private validateList(cache: CircleListCache) {
    if (!cache || !Array.isArray(cache.ids) || !cache.ids.length
      || !cache.ids.every(id => typeof id === 'string' && /^\d+$/.test(id))
      || new Set(cache.ids).size !== cache.ids.length
      || (cache.eventId !== null && (typeof cache.eventId !== 'string' || !/^\d+$/.test(cache.eventId)))
      || (cache.comiket !== null && (!Number.isSafeInteger(cache.comiket) || cache.comiket < 1))
      || typeof cache.completedAt !== 'string' || !Number.isFinite(Date.parse(cache.completedAt))) {
      throw new Error('完整社团列表缓存损坏，请检查数据库中的 circle_list_cache')
    }
  }

  async saveList(cache: CircleListCache) {
    this.validateList(cache)
    const value = { id: 'syllabary', state: JSON.stringify(cache) }
    await database().insert(circleListCache).values(value).onDuplicateKeyUpdate({ set: value })
  }

  async savedBooths(ids: string[]) {
    const records: { id: string; event_id: string; comiket: number }[] = []
    for (let offset = 0; offset < ids.length; offset += 1000) {
      records.push(...await database().select({
        id: booths.id, event_id: booths.event_id, comiket: booths.comiket,
      }).from(booths).where(inArray(booths.id, ids.slice(offset, offset + 1000))))
    }
    const [sample] = records.length
      ? await database().select().from(booths).where(eq(booths.id, records[0]!.id)).limit(1)
      : []
    return { records, sample: sample ?? null }
  }
}
