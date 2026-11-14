import { char, datetime, int, longtext, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core'

export const booths = mysqlTable('booths', {
  id: varchar('id', { length: 32 }).primaryKey(),
  event_id: varchar('event_id', { length: 32 }).notNull(),
  comiket: int('comiket').notNull(),
  circle_name: varchar('circle_name', { length: 255 }).notNull(),
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
  images: text('images').notNull(),
  source_url: text('source_url').notNull(),
  last_crawled_at: datetime('last_crawled_at', { mode: 'string' }).notNull(),
})

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
