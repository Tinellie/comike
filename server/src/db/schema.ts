import { boolean, char, datetime, index, int, json, longtext, mysqlTable, primaryKey, text, varchar } from 'drizzle-orm/mysql-core'

export const users = mysqlTable('users', {
  id: char('id', { length: 36 }).primaryKey(),
  internal_id: int('internal_id').autoincrement().notNull().unique(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  password_hash: varchar('password_hash', { length: 255 }).notNull(),
  is_admin: boolean('is_admin').notNull().default(false),
  created_at: datetime('created_at').notNull(),
})

export const sessions = mysqlTable('sessions', {
  token_hash: char('token_hash', { length: 64 }).primaryKey(),
  user_id: char('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires_at: datetime('expires_at').notNull(),
}, table => [index('sessions_expiry_idx').on(table.expires_at)])

export const userFavorites = mysqlTable('user_favorites', {
  user_id: int('user_id').notNull().references(() => users.internal_id, { onDelete: 'cascade' }),
  booth_id: varchar('booth_id', { length: 32 }).notNull(),
  colour: char('colour', { length: 7 }).notNull(),
  memo: text('memo').notNull(),
}, table => [primaryKey({ columns: [table.user_id, table.booth_id] })])

export const userColourPriorities = mysqlTable('user_colour_priorities', {
  user_id: int('user_id').notNull().references(() => users.internal_id, { onDelete: 'cascade' }),
  colour: char('colour', { length: 7 }).notNull(),
  priority: int('priority').notNull(),
}, table => [primaryKey({ columns: [table.user_id, table.colour] })])

export interface MapRectangle { x: number; y: number; width: number; height: number }

export const booths = mysqlTable('booths', {
  id: varchar('id', { length: 32 }).primaryKey(),
  event_id: varchar('event_id', { length: 32 }).notNull(),
  comiket: int('comiket').notNull(),
  circle_name: varchar('circle_name', { length: 255 }).notNull(),
  circle_name_reading: varchar('circle_name_reading', { length: 1024 }),
  author_name: varchar('author_name', { length: 255 }),
  weekday: char('weekday', { length: 1 }).notNull(),
  hall: varchar('hall', { length: 16 }).notNull(),
  island_code: varchar('island_code', { length: 32 }).notNull(),
  booth_number: char('booth_number', { length: 2 }).notNull(),
  booth_suffix: varchar('booth_suffix', { length: 2 }),
  genre: varchar('genre', { length: 255 }),
  genre_code: varchar('genre_code', { length: 16 }),
  circle_id: varchar('circle_id', { length: 32 }),
  pixiv_id: varchar('pixiv_id', { length: 32 }),
  twitter_id: varchar('twitter_id', { length: 64 }),
  circle_appeal: longtext('circle_appeal'),
  tags: longtext('tags'),
  images: text('images').notNull(),
  source_url: text('source_url').notNull(),
  last_crawled_at: datetime('last_crawled_at', { mode: 'string' }).notNull(),
}, table => [
  index('booths_event_id_idx').on(table.event_id),
  index('booths_location_idx').on(table.event_id, table.weekday, table.hall, table.island_code, table.booth_number, table.booth_suffix),
])

export const crawlJobs = mysqlTable('crawl_jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  state: longtext('state').notNull(),
  updated_at: datetime('updated_at').notNull(),
})

export const circleListCache = mysqlTable('circle_list_cache', {
  id: varchar('id', { length: 32 }).primaryKey(),
  state: longtext('state').notNull(),
})

export type Booth = typeof booths.$inferInsert

export const mapVacancies = mysqlTable('map_vacancies', {
  event_id: varchar('event_id', { length: 32 }).notNull(),
  comiket: int('comiket').notNull(),
  weekday: char('weekday', { length: 1 }).notNull(),
  hall: varchar('hall', { length: 16 }).notNull(),
  hall_group: varchar('hall_group', { length: 16 }).notNull(),
  island_code: varchar('island_code', { length: 32 }).notNull(),
  booth_number: char('booth_number', { length: 2 }).notNull(),
  booth_suffix: char('booth_suffix', { length: 1 }).notNull(),
  map_booth_id: varchar('map_booth_id', { length: 128 }).notNull(),
  checked_at: datetime('checked_at', { mode: 'string' }).notNull(),
}, table => [index('map_vacancies_event_idx').on(table.event_id),
  primaryKey({ columns: [table.event_id, table.weekday, table.hall_group, table.island_code, table.booth_number, table.booth_suffix] })])

export const mapVacancyRegions = mysqlTable('map_vacancy_regions', {
  event_id: varchar('event_id', { length: 32 }).notNull(),
  weekday: char('weekday', { length: 1 }).notNull(),
  hall_group: varchar('hall_group', { length: 16 }).notNull(),
  rectangles: json('rectangles').$type<MapRectangle[]>().notNull(),
  checked_at: datetime('checked_at', { mode: 'string' }).notNull(),
}, table => [primaryKey({ columns: [table.event_id, table.weekday, table.hall_group] })])

export const mapGenres = mysqlTable('map_genres', {
  event_id: varchar('event_id', { length: 32 }).notNull(),
  weekday: char('weekday', { length: 1 }).notNull(),
  genre_key: varchar('genre_key', { length: 300 }).notNull(),
  genre: varchar('genre', { length: 255 }),
  genre_code: varchar('genre_code', { length: 16 }),
  color: char('color', { length: 7 }).notNull(),
  circle_count: int('circle_count').notNull(),
  checked_at: datetime('checked_at', { mode: 'string' }).notNull(),
}, table => [primaryKey({ columns: [table.event_id, table.weekday, table.genre_key] })])

export const mapGenreRegions = mysqlTable('map_genre_regions', {
  event_id: varchar('event_id', { length: 32 }).notNull(),
  weekday: char('weekday', { length: 1 }).notNull(),
  hall_group: varchar('hall_group', { length: 16 }).notNull(),
  genre_key: varchar('genre_key', { length: 300 }).notNull(),
  rectangles: json('rectangles').$type<MapRectangle[]>().notNull(),
}, table => [primaryKey({ columns: [table.event_id, table.weekday, table.hall_group, table.genre_key] })])
