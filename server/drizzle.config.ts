import { defineConfig } from 'drizzle-kit'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

if (existsSync('.env')) {
  loadEnvFile('.env')
}

const url = process.env.DATABASE_URL
if (!url || new URL(url).protocol !== 'mysql:') {
  throw new Error('Set a valid MySQL DATABASE_URL in server/.env before running Drizzle commands')
}

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
})
