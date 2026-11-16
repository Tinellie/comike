import { and, eq, gt, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { sessions, users } from '../db/schema.js'

export interface AuthUser {
  id: string
  username: string
  isAdmin: boolean
}

export interface StoredUser extends AuthUser { passwordHash: string }

export interface AuthStore {
  findUser(username: string): Promise<StoredUser | null>
  createUser(user: StoredUser): Promise<boolean>
  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>
  sessionUser(tokenHash: string): Promise<AuthUser | null>
  deleteSession(tokenHash: string): Promise<void>
}

function database() {
  if (!db) throw new Error('DATABASE_URL is not configured')
  return db
}

export class MysqlAuthStore implements AuthStore {
  async findUser(username: string): Promise<StoredUser | null> {
    const [user] = await database().select().from(users).where(eq(users.username, username)).limit(1)
    return user ? { id: user.id, username: user.username, isAdmin: user.is_admin, passwordHash: user.password_hash } : null
  }

  async createUser(user: StoredUser): Promise<boolean> {
    try {
      await database().insert(users).values({
        id: user.id, username: user.username, password_hash: user.passwordHash,
        is_admin: false, created_at: new Date(),
      })
      return true
    } catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error
      if (typeof cause === 'object' && cause && 'code' in cause && cause.code === 'ER_DUP_ENTRY') return false
      throw error
    }
  }

  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await database().delete(sessions).where(lte(sessions.expires_at, new Date()))
    await database().insert(sessions).values({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt })
  }

  async sessionUser(tokenHash: string): Promise<AuthUser | null> {
    const [user] = await database().select({
      id: users.id, username: users.username, isAdmin: users.is_admin,
    }).from(sessions).innerJoin(users, eq(sessions.user_id, users.id))
      .where(and(eq(sessions.token_hash, tokenHash), gt(sessions.expires_at, new Date()))).limit(1)
    return user ?? null
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await database().delete(sessions).where(eq(sessions.token_hash, tokenHash))
  }
}
