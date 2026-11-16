import { and, count, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '../db/index.js'
import { booths, mapVacancies, mapVacancyRegions, mapGenres, mapGenreRegions, userFavorites, users, userColourPriorities } from '../db/schema.js'
import { BoothFilterError, eventDays, hallGroup } from './catalog.js'
import type { BoothQuery, HallGroup } from './catalog.js'
import { colourOrdering } from './colourOrder.js'

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

  private async dates(eventId: string) {
    const dates = await this.database.selectDistinct({ weekday: booths.weekday })
      .from(booths).where(eq(booths.event_id, eventId))
    return eventDays(dates.map(date => date.weekday))
  }

  async days(eventId?: string) {
    const [event] = await this.database.select({ eventId: booths.event_id, comiket: booths.comiket }).from(booths)
      .where(eventId ? eq(booths.event_id, eventId) : undefined)
      .orderBy(...(eventId ? [] : [sql`${booths.comiket} desc`, booths.event_id])).limit(1)
    if (!event) return eventId ? null : { event: null, days: [], warnings: [] }
    const { days, warning } = await this.dates(event.eventId)
    return { event, days, warnings: warning ? [warning] : [] }
  }

  private async locationOptions(eventId: string, groups: HallGroup[]) {
    const locations = await this.database.selectDistinct({
      weekday: booths.weekday, hall: booths.hall, island: booths.island_code, comiket: booths.comiket,
    }).from(booths).where(eq(booths.event_id, eventId))
    if (!locations.length) return null
    const { days, warning } = eventDays(locations.map(location => location.weekday))
    const mapped = new Set(locations.map(location => hallGroup(groups, location.hall, location.island)))
    const halls = [...groups.map(group => group.name), ...[...mapped].filter(name => !groups.some(group => group.name === name))]
      .filter(name => mapped.has(name))
    const warnings = warning ? [warning] : []
    if ([...mapped].some(name => name.includes('未匹配'))) warnings.push('部分 island 未在当前地图中匹配到场馆，已单独列为“未匹配”')
    return { event: { eventId, comiket: locations[0]!.comiket }, days, halls, warnings }
  }

  private async genres(eventId: string, groups: HallGroup[], days: Day[], ordered: boolean) {
    if (!ordered) {
      const rows = await this.database.selectDistinct({ genre: booths.genre }).from(booths).where(eq(booths.event_id, eventId))
      return rows.map(row => row.genre)
    }
    const ranked = this.database.select({
      genre: booths.genre,
      position: sql<number>`row_number() over (order by ${sql.join(this.locationOrdering(groups, days), sql`, `)}, ${booths.id} asc)`.as('position'),
    }).from(booths).where(eq(booths.event_id, eventId)).as('ranked')
    const genreRows = days.length ? await this.database.select({ genre: ranked.genre })
      .from(ranked).groupBy(ranked.genre).orderBy(sql`min(${ranked.position})`) : []
    return genreRows.map(row => row.genre)
  }

  async options(eventId?: string, userId?: string) {
    const [groups, events] = await Promise.all([
      this.loadGroups(),
      this.database.select({ eventId: booths.event_id, comiket: booths.comiket })
        .from(booths).groupBy(booths.event_id, booths.comiket).orderBy(sql`${booths.comiket} desc`, booths.event_id),
    ])
    const event = eventId ? events.find(event => event.eventId === eventId) : events[0]
    if (eventId && !event) return null
    if (!event) return { event: null, events, days: [], halls: [], genres: [], colours: [], warnings: [] }
    const options = await this.locationOptions(event.eventId, groups)
    if (!options) return null
    const [genres, colours] = await Promise.all([
      this.genres(event.eventId, groups, options.days, true),
      userId ? this.database.selectDistinct({ colour: userFavorites.colour, priority: userColourPriorities.priority }).from(userFavorites)
        .innerJoin(users, eq(users.internal_id, userFavorites.user_id))
        .innerJoin(booths, eq(booths.id, userFavorites.booth_id))
        .leftJoin(userColourPriorities, and(
          eq(userColourPriorities.user_id, userFavorites.user_id), eq(userColourPriorities.colour, userFavorites.colour),
        ))
        .where(and(eq(users.id, userId), eq(booths.event_id, event.eventId)))
        .orderBy(...colourOrdering(sql`${userFavorites.colour}`, false, sql`${userColourPriorities.priority}`)) : [],
    ])
    return { ...options, events, genres, colours: colours.map(row => row.colour) }
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

  async list(query: BoothQuery, userId?: string) {
    const groups = await this.loadGroups()
    const options = await this.locationOptions(query.eventId, groups)
    if (!options?.event) return null
    const emptySelection = query.days?.length === 0 || query.halls?.length === 0 || query.genres?.length === 0 || query.colours?.length === 0
    const orderedGenres = query.sort === 'genre' && !emptySelection
    const genres = orderedGenres || query.genres?.length
      ? await this.genres(query.eventId, groups, options.days, orderedGenres) : []
    if (query.days?.some(day => !options.days.some(option => option.weekday === day))
      || query.halls?.some(hall => !options.halls.includes(hall))
      || query.genres?.some(genre => !genres.includes(genre))) throw new BoothFilterError('筛选项不属于当前活动')
    if (!options.days.length || emptySelection) {
      return { items: [], total: 0, nextOffset: null }
    }
    const group = this.groupExpression(groups)
    const favorites = userId ? this.database.select({
      boothId: userFavorites.booth_id, colour: userFavorites.colour, memo: userFavorites.memo,
      priority: userColourPriorities.priority,
    }).from(userFavorites).innerJoin(users, eq(users.internal_id, userFavorites.user_id))
      .leftJoin(userColourPriorities, and(
        eq(userColourPriorities.user_id, userFavorites.user_id), eq(userColourPriorities.colour, userFavorites.colour),
      ))
      .where(eq(users.id, userId)).as('favorites') : undefined
    const colour = favorites ? sql<string | null>`${favorites.colour}` : sql<null>`null`
    const filters = [eq(booths.event_id, query.eventId)]
    if (query.search) {
      const matches = [booths.circle_name, booths.author_name, booths.genre, booths.tags]
        .map(column => sql`locate(${query.search}, ${column}) > 0`)
      if (favorites) matches.push(sql`locate(${query.search}, ${favorites.memo}) > 0`)
      filters.push(or(...matches)!)
    }
    if (query.days) filters.push(query.days.length ? inArray(booths.weekday, query.days) : sql`false`)
    if (query.halls) filters.push(query.halls.length ? inArray(group, query.halls) : sql`false`)
    if (query.genres) {
      const names = query.genres.filter((genre): genre is string => genre !== null)
      filters.push(or(
        names.length ? inArray(booths.genre, names) : sql`false`,
        query.genres.includes(null) ? isNull(booths.genre) : sql`false`,
      )!)
    }
    if (query.colours) {
      const selected = query.colours.filter((value): value is string => value !== null)
      filters.push(or(
        selected.length ? inArray(colour, selected) : sql`false`,
        query.colours.includes(null) ? isNull(colour) : sql`false`,
      )!)
    }
    const where = and(...filters)
    const ascending = query.direction === 'asc'
    function order(expression: SQL | typeof booths.id, reverse = false) {
      return sql`${expression} ${sql.raw(ascending !== reverse ? 'asc' : 'desc')}`
    }
    const ordering = query.sort === 'colour'
      ? [...colourOrdering(colour, !ascending, favorites ? sql`${favorites.priority}` : sql`null`), ...this.locationOrdering(groups, options.days)]
      : query.sort === 'name'
      ? [order(sql`coalesce(${booths.circle_name_reading}, ${booths.circle_name}) collate utf8mb4_unicode_ci`)]
      : query.sort === 'genre'
        ? [order(sql`case ${sql.join(genres.map((genre, index) =>
          sql`when ${booths.genre} <=> ${genre} then ${index}`), sql` `)} else ${genres.length} end`),
          ...this.locationOrdering(groups, options.days)]
        : this.locationOrdering(groups, options.days, !ascending)
    const rowQuery = this.database.select({
        id: booths.id, event_id: booths.event_id, comiket: booths.comiket,
        circle_name: booths.circle_name, circle_name_reading: booths.circle_name_reading, author_name: booths.author_name,
        weekday: booths.weekday, hall: booths.hall, island_code: booths.island_code,
        booth_number: booths.booth_number, booth_suffix: booths.booth_suffix,
        genre: booths.genre, tags: sql<string | null>`substring(${booths.tags}, 1, 512)`,
        circle_id: booths.circle_id, pixiv_id: booths.pixiv_id, twitter_id: booths.twitter_id,
        images: booths.images,
        colour: favorites ? favorites.colour : sql<null>`null`,
        memo: favorites ? favorites.memo : sql<null>`null`,
      }).from(booths)
    const totalQuery = this.database.select({ total: count() }).from(booths)
    const rowsSource = favorites ? rowQuery.leftJoin(favorites, eq(favorites.boothId, booths.id)) : rowQuery
    const totalsSource = favorites && (query.search || query.colours) ? totalQuery.leftJoin(favorites, eq(favorites.boothId, booths.id)) : totalQuery
    const [rows, totals] = await Promise.all([
      rowsSource.where(where).orderBy(...ordering, query.sort === 'genre' || query.sort === 'colour' ? sql`${booths.id} asc` : order(booths.id)).limit(query.limit).offset(query.offset),
      totalsSource.where(where),
    ])
    const total = totals[0]!.total
    return {
      items: rows.map(row => presentation(row, groups, options.days)), total,
      nextOffset: query.offset + rows.length < total ? query.offset + rows.length : null,
    }
  }

  async detail(id: string, userId?: string) {
    const [row] = await this.database.select().from(booths).where(eq(booths.id, id)).limit(1)
    if (!row) return null
    const [dates, groups, favorites] = await Promise.all([
      this.dates(row.event_id), this.loadGroups(),
      userId ? this.database.select({ memo: userFavorites.memo, colour: userFavorites.colour }).from(userFavorites)
        .innerJoin(users, eq(users.internal_id, userFavorites.user_id))
        .where(and(eq(users.id, userId), eq(userFavorites.booth_id, id))).limit(1) : [],
    ])
    return { ...presentation(row, groups, dates.days), memo: favorites[0]?.memo ?? null, colour: favorites[0]?.colour ?? null }
  }

  async mapData(eventId: string, weekday: string) {
    const filter = and(eq(mapGenres.event_id, eventId), eq(mapGenres.weekday, weekday))
    const [mergedRows, vacancyRows, vacancyRegions, genres, genreRegions] = await Promise.all([
      this.database.select({ island: booths.island_code, number: booths.booth_number })
        .from(booths).where(and(eq(booths.event_id, eventId), eq(booths.weekday, weekday), eq(booths.booth_suffix, 'ab'))),
      this.database.select({ island: mapVacancies.island_code, number: mapVacancies.booth_number, suffix: mapVacancies.booth_suffix })
        .from(mapVacancies).where(and(eq(mapVacancies.event_id, eventId), eq(mapVacancies.weekday, weekday))),
      this.database.select({ hallGroup: mapVacancyRegions.hall_group, rectangles: mapVacancyRegions.rectangles })
        .from(mapVacancyRegions).where(and(eq(mapVacancyRegions.event_id, eventId), eq(mapVacancyRegions.weekday, weekday))),
      this.database.select({ key: mapGenres.genre_key, name: mapGenres.genre, code: mapGenres.genre_code,
        color: mapGenres.color, count: mapGenres.circle_count }).from(mapGenres).where(filter).orderBy(mapGenres.genre_key),
      this.database.select({ hallGroup: mapGenreRegions.hall_group, genreKey: mapGenreRegions.genre_key, rectangles: mapGenreRegions.rectangles })
        .from(mapGenreRegions).where(and(eq(mapGenreRegions.event_id, eventId), eq(mapGenreRegions.weekday, weekday))),
    ])
    function group(rows: { island: string; number: string; suffix?: string }[]) {
      const islands = new Map<string, Set<string>>()
      for (const row of rows) {
        const code = row.island.normalize('NFKC')
        const values = islands.get(code) ?? new Set<string>()
        values.add(`${row.number.padStart(2, '0')}${row.suffix ?? ''}`)
        islands.set(code, values)
      }
      return Object.fromEntries([...islands].map(([island, values]) => [island, [...values].sort()]))
    }
    return { merged: group(mergedRows), vacancies: group(vacancyRows), vacancyRegions, genres, genreRegions,
      vacancyReady: vacancyRegions.length > 0, genreReady: genres.length > 0 }
  }

  async mapFavorites(eventId: string, weekday: string, userId: string) {
    const [groups, rows] = await Promise.all([
      this.loadGroups(),
      this.database.select({
        boothId: booths.id, hall: booths.hall, island: booths.island_code,
        number: booths.booth_number, suffix: booths.booth_suffix, colour: userFavorites.colour,
      }).from(userFavorites)
        .innerJoin(users, eq(users.internal_id, userFavorites.user_id))
        .innerJoin(booths, eq(booths.id, userFavorites.booth_id))
        .where(and(eq(users.id, userId), eq(booths.event_id, eventId), eq(booths.weekday, weekday)))
        .orderBy(booths.id),
    ])
    return rows.map(({ hall, ...row }) => {
      if (!/^#[\dA-F]{6}$/i.test(row.colour)) throw new Error(`Favorite ${row.boothId} has an invalid colour`)
      return { ...row, hallGroup: hallGroup(groups, hall, row.island) }
    })
  }

  async atLocation(query: { eventId: string; weekday: string; hallGroup: string; island: string; number: string; suffix: 'a' | 'b' }) {
    const [options, groups] = await Promise.all([this.days(query.eventId), this.loadGroups()])
    if (!options?.event) return null
    if (!options.days.some(day => day.weekday === query.weekday) || !/^[東西南北]\d+$/.test(query.hallGroup)) {
      throw new BoothFilterError('地图日期或场馆无效')
    }
    if (hallGroup(groups, query.hallGroup[0]!, query.island) !== query.hallGroup) throw new BoothFilterError('地图位置不属于当前场馆')
    const rows = await this.database.select().from(booths).where(and(
      eq(booths.event_id, query.eventId), eq(booths.weekday, query.weekday), eq(booths.hall, query.hallGroup[0]!),
      eq(booths.island_code, query.island.normalize('NFKC')),
      sql`binary ${booths.island_code} = ${query.island.normalize('NFKC')}`,
      eq(booths.booth_number, query.number.padStart(2, '0')),
      inArray(booths.booth_suffix, [query.suffix, 'ab']),
    )).orderBy(booths.id)
    const vacancies = rows.length ? [] : await this.database.select().from(mapVacancies).where(and(
      eq(mapVacancies.event_id, query.eventId), eq(mapVacancies.weekday, query.weekday),
      eq(mapVacancies.hall_group, query.hallGroup), sql`binary ${mapVacancies.island_code} = ${query.island.normalize('NFKC')}`,
      eq(mapVacancies.booth_number, query.number.padStart(2, '0')), eq(mapVacancies.booth_suffix, query.suffix),
    ))
    return { circles: rows.map(row => presentation(row, groups, options.days)), vacancy: vacancies[0] ?? null }
  }
}

export type BoothStore = Pick<MysqlBoothRepository, 'options' | 'days' | 'list' | 'detail' | 'atLocation' | 'mapData' | 'mapFavorites'>
