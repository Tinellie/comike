import { and, count, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '../db/index.js'
import { booths } from '../db/schema.js'
import { BoothFilterError, eventDays, hallGroup } from './catalog.js'
import type { BoothQuery, HallGroup } from './catalog.js'

type Database = Pick<NonNullable<typeof db>, 'select' | 'selectDistinct'>
type Day = ReturnType<typeof eventDays>['days'][number]

function database() {
  if (!db) throw new Error('DATABASE_URL is not configured')
  return db
}

function presentation<T extends { id: string; comiket: number; weekday: string; hall: string; island_code: string; images: string }>(
  row: T, groups: HallGroup[], days: Day[],
) {
  const images: unknown = JSON.parse(row.images)
  if (!Array.isArray(images) || !images.every((name: unknown): name is string =>
    typeof name === 'string' && /^\d+_[1-9]\d*\.(png|jpe?g|gif|webp)$/i.test(name) && name.startsWith(`${row.id}_`))) {
    throw new Error(`Booth ${row.id} 的图片文件名数组无效`)
  }
  const day = days.find(day => day.weekday === row.weekday)
  if (!day) throw new Error(`Booth ${row.id} 的曜日不在活动日期中`)
  return {
    ...row, images,
    imageUrls: images.map(name => `/api/booths/images/c${row.comiket}/${name}`),
    dayLabel: day.label, dayOrder: day.order,
    hallGroup: hallGroup(groups, row.hall, row.island_code),
  }
}

export class MysqlBoothRepository {
  private readonly loadGroups: () => Promise<HallGroup[]>
  private readonly connection: Database | undefined

  constructor(loadGroups: () => Promise<HallGroup[]>, connection?: Database) {
    this.loadGroups = loadGroups
    this.connection = connection
  }

  private get database() { return this.connection ?? database() }

  async options(eventId?: string) {
    const groups = await this.loadGroups()
    const events = await this.database.select({ eventId: booths.event_id, comiket: booths.comiket })
      .from(booths).groupBy(booths.event_id, booths.comiket).orderBy(sql`${booths.comiket} desc`, booths.event_id)
    const event = eventId ? events.find(event => event.eventId === eventId) : events[0]
    if (eventId && !event) return null
    if (!event) return { event: null, events, days: [], halls: [], genres: [], warnings: [] }
    const locations = await this.database.selectDistinct({
      weekday: booths.weekday, hall: booths.hall, island: booths.island_code,
    }).from(booths).where(eq(booths.event_id, event.eventId))
    const { days, warning } = eventDays(locations.map(location => location.weekday))
    const mapped = new Set(locations.map(location => hallGroup(groups, location.hall, location.island)))
    const halls = [...groups.map(group => group.name), ...[...mapped].filter(name => !groups.some(group => group.name === name))]
      .filter(name => mapped.has(name))
    const warnings = warning ? [warning] : []
    if ([...mapped].some(name => name.includes('未匹配'))) warnings.push('部分 island 未在当前地图中匹配到场馆，已单独列为“未匹配”')
    const ranked = this.database.select({
      genre: booths.genre,
      position: sql<number>`row_number() over (order by ${sql.join(this.locationOrdering(groups, days), sql`, `)}, ${booths.id} asc)`.as('position'),
    }).from(booths).where(eq(booths.event_id, event.eventId)).as('ranked')
    const genreRows = days.length ? await this.database.select({ genre: ranked.genre })
      .from(ranked).groupBy(ranked.genre).orderBy(sql`min(${ranked.position})`) : []
    return { event, events, days, halls, genres: genreRows.map(row => row.genre), warnings }
  }

  private groupExpression(groups: HallGroup[]) {
    const branches = groups.filter(group => group.islands.length).map(group =>
      sql`when ${booths.hall} = ${group.direction} and binary ${booths.island_code} in (${sql.join(group.islands.map(code => sql`${code}`), sql`, `)}) then ${group.name}`)
    const fallback = sql`concat(${booths.hall}, '（未匹配）')`
    return branches.length ? sql<string>`case ${sql.join(branches, sql` `)} else ${fallback} end` : fallback
  }

  private locationOrdering(groups: HallGroup[], days: Day[], descending = false) {
    const group = this.groupExpression(groups)
    const day = days.length
      ? sql`case ${sql.join(days.map(day => sql`when ${booths.weekday} = ${day.weekday} then ${day.order}`), sql` `)} else 99 end`
      : sql`99`
    const expressions = [
      { value: day },
      { value: sql`case ${booths.hall} when '東' then 0 when '西' then 1 when '南' then 2 when '北' then 3 else 4 end` },
      { value: sql`cast(substring(${group}, 2) as unsigned)`, reverse: true },
      { value: group },
      { value: sql`${booths.island_code} collate utf8mb4_unicode_ci` },
      { value: sql`cast(${booths.booth_number} as unsigned)` },
      { value: sql`case coalesce(${booths.booth_suffix}, '') when '' then 0 when 'a' then 1 when 'ab' then 2 when 'b' then 3 else 4 end` },
    ]
    return expressions.map(({ value, reverse }) => sql`${value} ${sql.raw(descending !== !!reverse ? 'desc' : 'asc')}`)
  }

  async list(query: BoothQuery) {
    const options = await this.options(query.eventId)
    if (!options?.event) return null
    if (query.days?.some(day => !options.days.some(option => option.weekday === day))
      || query.halls?.some(hall => !options.halls.includes(hall))
      || query.genres?.some(genre => !options.genres.includes(genre))) throw new BoothFilterError('筛选项不属于当前活动')
    if (!options.days.length || !options.genres.length) return { items: [], total: 0, nextOffset: null }
    const groups = await this.loadGroups()
    const group = this.groupExpression(groups)
    const filters = [eq(booths.event_id, query.eventId)]
    if (query.days) filters.push(query.days.length ? inArray(booths.weekday, query.days) : sql`false`)
    if (query.halls) filters.push(query.halls.length ? inArray(group, query.halls) : sql`false`)
    if (query.genres) {
      const names = query.genres.filter((genre): genre is string => genre !== null)
      filters.push(or(
        names.length ? inArray(booths.genre, names) : sql`false`,
        query.genres.includes(null) ? isNull(booths.genre) : sql`false`,
      )!)
    }
    const where = and(...filters)
    const ascending = query.direction === 'asc'
    function order(expression: SQL | typeof booths.id, reverse = false) {
      return sql`${expression} ${sql.raw(ascending !== reverse ? 'asc' : 'desc')}`
    }
    const ordering = query.sort === 'name'
      ? [order(sql`coalesce(${booths.circle_name_reading}, ${booths.circle_name}) collate utf8mb4_unicode_ci`)]
      : query.sort === 'genre'
        ? [order(sql`case ${sql.join(options.genres.map((genre, index) =>
          sql`when ${booths.genre} <=> ${genre} then ${index}`), sql` `)} else ${options.genres.length} end`),
          ...this.locationOrdering(groups, options.days)]
        : this.locationOrdering(groups, options.days, !ascending)
    const [rows, totals] = await Promise.all([
      this.database.select({
        id: booths.id, event_id: booths.event_id, comiket: booths.comiket,
        circle_name: booths.circle_name, circle_name_reading: booths.circle_name_reading, author_name: booths.author_name,
        weekday: booths.weekday, hall: booths.hall, island_code: booths.island_code,
        booth_number: booths.booth_number, booth_suffix: booths.booth_suffix,
        genre: booths.genre, tags: sql<string | null>`substring(${booths.tags}, 1, 512)`,
        circle_id: booths.circle_id, pixiv_id: booths.pixiv_id, twitter_id: booths.twitter_id,
        images: booths.images,
      }).from(booths).where(where).orderBy(...ordering, query.sort === 'genre' ? sql`${booths.id} asc` : order(booths.id)).limit(query.limit).offset(query.offset),
      this.database.select({ total: count() }).from(booths).where(where),
    ])
    const total = totals[0]!.total
    return {
      items: rows.map(row => presentation(row, groups, options.days)), total,
      nextOffset: query.offset + rows.length < total ? query.offset + rows.length : null,
    }
  }

  async detail(id: string) {
    const [row] = await this.database.select().from(booths).where(eq(booths.id, id)).limit(1)
    if (!row) return null
    const options = await this.options(row.event_id)
    if (!options) throw new Error('详情所属活动不存在')
    return presentation(row, await this.loadGroups(), options.days)
  }
}

export type BoothStore = Pick<MysqlBoothRepository, 'options' | 'list' | 'detail'>
