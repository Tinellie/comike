import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

export function colourOrdering(colour: SQL, descending: boolean, priority: SQL = sql`null`): SQL[] {
  const direction = sql.raw(descending ? 'desc' : 'asc')
  return [
    sql`${colour} is null asc`,
    sql`${priority} is null asc`,
    sql`${priority} ${direction}`,
    sql`binary ${colour} ${direction}`,
  ]
}
