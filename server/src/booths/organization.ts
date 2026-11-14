import { count, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { booths, mapGenres, mapVacancies, mapVacancyRegions } from '../db/schema.js'
import { organizeMapGenres } from './genres.js'
import { reconcileMapVacancies } from './reconcile.js'

export class MapOrganization {
  constructor(privateFile: string) { this.file = privateFile }
  private readonly file: string

  private get database() {
    if (!db) throw new Error('DATABASE_URL is not configured')
    return db
  }

  private async event() {
    const [row] = await this.database.select({ eventId: booths.event_id, comiket: booths.comiket })
      .from(booths).orderBy(desc(booths.comiket), desc(booths.event_id)).limit(1)
    return row ?? null
  }

  async status() {
    const event = await this.event()
    if (!event) return { event: null, vacancies: 0, vacancyReady: false, genreReady: false }
    const [vacancies, regions, genres] = await Promise.all([
      this.database.select({ total: count() }).from(mapVacancies).where(eq(mapVacancies.event_id, event.eventId)),
      this.database.select({ weekday: mapVacancyRegions.weekday }).from(mapVacancyRegions).where(eq(mapVacancyRegions.event_id, event.eventId)).limit(1),
      this.database.select({ key: mapGenres.genre_key }).from(mapGenres).where(eq(mapGenres.event_id, event.eventId)).limit(1),
    ])
    return { event, vacancies: vacancies[0]!.total, vacancyReady: regions.length > 0, genreReady: genres.length > 0 }
  }

  async run(kind: 'vacancies' | 'genres') {
    const event = await this.event()
    if (!event) throw new Error('没有可整理的社团活动，请先采集数据')
    if (kind === 'vacancies') return reconcileMapVacancies(this.file, event.eventId)
    return organizeMapGenres(this.file, event.eventId)
  }
}
