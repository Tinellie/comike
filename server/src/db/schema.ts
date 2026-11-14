import { char, datetime, index, int, longtext, mysqlTable, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

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
}, table => [index('booths_event_id_idx').on(table.event_id)])

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
  id: varchar('id', { length: 64 }).primaryKey(),
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
  uniqueIndex('map_vacancies_location_idx').on(table.event_id, table.weekday, table.hall_group, table.island_code, table.booth_number, table.booth_suffix)])
