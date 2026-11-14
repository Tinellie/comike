import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'

export async function initializeDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl)
  const name = decodeURIComponent(url.pathname.slice(1))
  if (url.protocol !== 'mysql:' || !/^[a-zA-Z0-9_]{1,64}$/.test(name)) {
    throw new Error('DATABASE_URL must specify a MySQL database name using letters, numbers or underscores')
  }
  url.pathname = '/'
  const connection = await mysql.createConnection(url.href)
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } finally {
    await connection.end()
  }
  const target = await mysql.createConnection(databaseUrl)
  try {
    await migrate(drizzle(target), {
      migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)),
    })
  } finally {
    await target.end()
  }
}
