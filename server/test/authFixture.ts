import express from 'express'
import { createApp } from '../src/app.js'
import type { AppOptions } from '../src/app.js'
import type { AuthStore, AuthUser, StoredUser } from '../src/auth/repository.js'
import { tokenHash } from '../src/auth/routes.js'

export class MemoryAuthStore implements AuthStore {
  users = new Map<string, StoredUser>()
  sessions = new Map<string, { userId: string; expiresAt: Date }>()
  async findUser(username: string) { return this.users.get(username) ?? null }
  async createUser(user: StoredUser) {
    if (this.users.has(user.username)) return false
    this.users.set(user.username, { ...user, isAdmin: false })
    return true
  }
  async createSession(hash: string, userId: string, expiresAt: Date) {
    this.sessions.set(hash, { userId, expiresAt })
  }
  async sessionUser(hash: string): Promise<AuthUser | null> {
    const session = this.sessions.get(hash)
    if (!session || session.expiresAt <= new Date()) return null
    const user = [...this.users.values()].find(user => user.id === session.userId)
    return user ? { id: user.id, username: user.username, isAdmin: user.isAdmin } : null
  }
  async deleteSession(hash: string) { this.sessions.delete(hash) }
}

// Existing functional tests exercise authorized operations; auth.test.ts covers real login and denials.
export function createAdminApp(options: AppOptions) {
  const store = new MemoryAuthStore()
  const token = 'a'.repeat(64)
  store.users.set('admin', { id: 'admin', username: 'admin', isAdmin: true, passwordHash: '' })
  store.sessions.set(tokenHash(token), { userId: 'admin', expiresAt: new Date(Date.now() + 60_000) })
  const app = express()
  app.use((req, _res, next) => { req.headers.cookie = `comike_session=${token}`; next() })
  app.use(createApp({ ...options, authStore: store }))
  return app
}
