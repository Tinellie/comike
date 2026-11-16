import { eq } from 'drizzle-orm'
import { db, pool } from '../db/index.js'
import { users } from '../db/schema.js'

try {
  const [username, role, ...extra] = process.argv.slice(2)
  if (!username || !/^[a-zA-Z0-9_]{3,32}$/.test(username)
    || (role !== 'grant' && role !== 'revoke') || extra.length) {
    throw new Error('Usage: npm run auth:admin -w server -- <username> <grant|revoke>')
  }
  if (!db) throw new Error('DATABASE_URL is not configured')
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.username, username.toLowerCase())).limit(1)
  if (!user) throw new Error('User not found; register the account first')
  await db.update(users).set({ is_admin: role === 'grant' }).where(eq(users.id, user.id))
  console.info(`Administrator access ${role === 'grant' ? 'granted' : 'revoked'}`)
} catch (error) {
  console.error('Administrator update failed:', error)
  process.exitCode = 1
} finally {
  await pool?.end()
}
