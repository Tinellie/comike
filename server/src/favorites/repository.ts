import { count, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { userFavorites, users } from '../db/schema.js'
import type { Favorite } from './parser.js'

export interface FavoritesStore {
  count(userId: string): Promise<number>
  replace(userId: string, entries: Favorite[]): Promise<void>
}

function database() {
  if (!db) throw new Error('DATABASE_URL is not configured')
  return db
}

export class MysqlFavoritesStore implements FavoritesStore {
  async count(userId: string): Promise<number> {
    const [result] = await database().select({ count: count() }).from(userFavorites)
      .innerJoin(users, eq(users.internal_id, userFavorites.user_id)).where(eq(users.id, userId))
    return result?.count ?? 0
  }

  async replace(userId: string, entries: Favorite[]): Promise<void> {
    await database().transaction(async tx => {
      const [user] = await tx.select({ id: users.internal_id }).from(users).where(eq(users.id, userId)).for('update')
      if (!user) throw new Error('Import user no longer exists')
      await tx.delete(userFavorites).where(eq(userFavorites.user_id, user.id))
      for (let offset = 0; offset < entries.length; offset += 500) {
        await tx.insert(userFavorites).values(entries.slice(offset, offset + 500).map(entry => ({
          user_id: user.id, booth_id: entry.boothId, colour: entry.colour, memo: entry.memo,
        })))
      }
    })
  }
}
