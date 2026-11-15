import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { userColourPriorities, userFavorites, users } from '../db/schema.js'

type Database = NonNullable<typeof db>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface ColourPriority {
  colour: string
  priority: number
}

export class ColourOrderConflictError extends Error {}

function database() {
  if (!db) throw new Error('DATABASE_URL is not configured')
  return db
}

// Callers lock the user row first, serializing imports and priority changes.
export async function syncColourPriorities(tx: Transaction, userId: number): Promise<ColourPriority[]> {
  const saved = await tx.select({ colour: userColourPriorities.colour, priority: userColourPriorities.priority })
    .from(userColourPriorities).where(eq(userColourPriorities.user_id, userId))
    .orderBy(userColourPriorities.priority, userColourPriorities.colour)
  const colours = await tx.selectDistinct({ colour: userFavorites.colour }).from(userFavorites)
    .where(eq(userFavorites.user_id, userId)).orderBy(userFavorites.colour)
  const known = new Set(saved.map(entry => entry.colour))
  let next = saved.reduce((max, entry) => Math.max(max, entry.priority + 1), 0)
  const added = colours.filter(entry => !known.has(entry.colour)).map(entry => ({
    user_id: userId, colour: entry.colour, priority: next++,
  }))
  for (let offset = 0; offset < added.length; offset += 500) {
    await tx.insert(userColourPriorities).values(added.slice(offset, offset + 500))
  }
  return [...saved, ...added.map(({ colour, priority }) => ({ colour, priority }))]
}

export class MysqlColourStore {
  private readonly connection: Pick<Database, 'transaction'> | undefined

  constructor(connection?: Pick<Database, 'transaction'>) {
    this.connection = connection
  }

  private async withUser<T>(userId: string, operation: (tx: Transaction, internalId: number) => Promise<T>): Promise<T> {
    return (this.connection ?? database()).transaction(async tx => {
      const [user] = await tx.select({ id: users.internal_id }).from(users).where(eq(users.id, userId)).for('update')
      if (!user) throw new Error('Colour preference user no longer exists')
      return operation(tx, user.id)
    })
  }

  async list(userId: string): Promise<ColourPriority[]> {
    return this.withUser(userId, (tx, id) => syncColourPriorities(tx, id))
  }

  async reorder(userId: string, colours: string[]): Promise<ColourPriority[]> {
    return this.withUser(userId, async (tx, id) => {
      const current = await syncColourPriorities(tx, id)
      const known = new Set(current.map(entry => entry.colour))
      if (colours.length !== known.size || new Set(colours).size !== colours.length || colours.some(colour => !known.has(colour))) {
        throw new ColourOrderConflictError('颜色列表已变更，请重新加载后排序')
      }
      for (const [priority, colour] of colours.entries()) {
        await tx.update(userColourPriorities).set({ priority }).where(and(
          eq(userColourPriorities.user_id, id), eq(userColourPriorities.colour, colour),
        ))
      }
      return colours.map((colour, priority) => ({ colour, priority }))
    })
  }
}

export type ColourStore = Pick<MysqlColourStore, 'list' | 'reorder'>
