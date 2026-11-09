import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from './schema.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl && new URL(databaseUrl).protocol !== 'mysql:') {
  throw new Error('DATABASE_URL must use the mysql protocol')
}

export const pool = databaseUrl ? mysql.createPool(databaseUrl) : undefined
export const db = pool ? drizzle({ client: pool, schema, mode: 'default' }) : undefined

export async function checkDatabase(): Promise<void> {
  if (!db) {
    throw new Error('DATABASE_URL is not configured')
  }
  await db.execute(sql`SELECT 1`)
}
