import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { booths, imagesPixiv, userFavorites, users } from '../../db/schema.js'

type Database = Pick<NonNullable<typeof db>, 'select' | 'transaction' | 'update'>
export interface PixivBooth { id: string; pixivId: string | null; updatedAt: Date | null }
export interface PixivStore {
  booth(id: string): Promise<PixivBooth | null>
  favorites(userId: string, missingOnly: boolean): Promise<string[]>
  images(pixivId: string): Promise<string[]>
  replace(pixivId: string, imageIds: string[]): Promise<void>
  touch(pixivId: string, date: Date): Promise<void>
}

export class MysqlPixivStore implements PixivStore {
  constructor(privateConnection?: Database) { this.connection = privateConnection }
  private readonly connection: Database | undefined
  private get database() {
    const connection = this.connection ?? db
    if (!connection) throw new Error('DATABASE_URL is not configured')
    return connection
  }

  async booth(id: string) {
    const [row] = await this.database.select({
      id: booths.id, pixivId: booths.pixiv_id, updatedAt: booths.pixiv_images_updated_at,
    }).from(booths).where(eq(booths.id, id)).limit(1)
    return row ?? null
  }

  async favorites(userId: string, missingOnly: boolean) {
    const rows = await this.database.select({ id: sql<string>`min(${booths.id})` })
      .from(userFavorites).innerJoin(users, eq(users.internal_id, userFavorites.user_id))
      .innerJoin(booths, eq(booths.id, userFavorites.booth_id))
      .where(and(eq(users.id, userId), isNotNull(userFavorites.colour),
        isNotNull(booths.pixiv_id), sql`${booths.pixiv_id} <> ''`,
        missingOnly ? isNull(booths.pixiv_images_updated_at) : undefined))
      .groupBy(booths.pixiv_id).orderBy(booths.pixiv_id)
    return rows.map(row => row.id)
  }

  async images(pixivId: string) {
    const rows = await this.database.select({ id: imagesPixiv.image_id }).from(imagesPixiv)
      .where(eq(imagesPixiv.pixiv_id, pixivId))
    return rows.map(row => row.id)
  }

  async replace(pixivId: string, imageIds: string[]) {
    await this.database.transaction(async tx => {
      await tx.delete(imagesPixiv).where(eq(imagesPixiv.pixiv_id, pixivId))
      if (imageIds.length) await tx.insert(imagesPixiv).values(imageIds.map(image_id => ({ pixiv_id: pixivId, image_id })))
    })
  }

  async touch(pixivId: string, date: Date) {
    await this.database.update(booths).set({ pixiv_images_updated_at: date }).where(eq(booths.pixiv_id, pixivId))
  }
}
