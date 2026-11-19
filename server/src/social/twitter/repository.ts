import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { booths, imagesTwitter, userFavorites, users } from '../../db/schema.js'
import type { TwitterImage } from './source.js'

export interface TwitterBooth { id: string; username: string | null; numberId: string | null; updatedAt: Date | null }
export interface TwitterStore {
  booth(id: string): Promise<TwitterBooth | null>
  favorites(userId: string, missingOnly: boolean): Promise<string[]>
  resolve(username: string, numberId: string): Promise<void>
  images(numberId: string): Promise<string[]>
  replace(numberId: string, images: TwitterImage[]): Promise<void>
  complete(numberId: string, images: TwitterImage[], date: Date): Promise<void>
}
export class MysqlTwitterStore implements TwitterStore {
  private get database() {
    if (!db) throw new Error('DATABASE_URL is not configured')
    return db
  }
  async booth(id: string) {
    const [row] = await this.database.select({
      id: booths.id, username: booths.twitter_id, numberId: booths.twitter_number_id, updatedAt: booths.twitter_images_updated_at,
    }).from(booths).where(eq(booths.id, id)).limit(1)
    return row ?? null
  }
  async favorites(userId: string, missingOnly: boolean) {
    const rows = await this.database.select({ id: sql<string>`min(${booths.id})` }).from(userFavorites)
      .innerJoin(users, eq(users.internal_id, userFavorites.user_id)).innerJoin(booths, eq(booths.id, userFavorites.booth_id))
      .where(and(eq(users.id, userId), isNotNull(userFavorites.colour), sql`${booths.twitter_id} is not null and ${booths.twitter_id} <> ''`,
        missingOnly ? isNull(booths.twitter_images_updated_at) : undefined))
      .groupBy(sql`coalesce(${booths.twitter_number_id}, lower(${booths.twitter_id}))`).orderBy(sql`min(${booths.twitter_id})`)
    return rows.map(row => row.id)
  }
  async resolve(username: string, numberId: string) {
    await this.database.update(booths).set({ twitter_number_id: numberId })
      .where(sql`lower(${booths.twitter_id}) = lower(${username})`)
  }
  async images(numberId: string) {
    return (await this.database.select({ id: imagesTwitter.image_id }).from(imagesTwitter)
      .where(eq(imagesTwitter.twitter_number_id, numberId))
      .orderBy(desc(imagesTwitter.tweet_created_at), desc(sql`cast(${imagesTwitter.tweet_id} as decimal(32, 0))`),
        asc(imagesTwitter.media_index), desc(sql`cast(${imagesTwitter.image_id} as decimal(32, 0))`))).map(row => row.id)
  }
  private async replaceIndex(connection: Pick<NonNullable<typeof db>, 'delete' | 'insert'>, numberId: string, images: TwitterImage[]) {
    await connection.delete(imagesTwitter).where(eq(imagesTwitter.twitter_number_id, numberId))
    if (images.length) await connection.insert(imagesTwitter).values(images.map(image => ({
      image_id: image.id, twitter_number_id: numberId, tweet_id: image.tweetId,
      tweet_created_at: image.publishedAt, media_index: image.mediaIndex,
    })))
  }
  async replace(numberId: string, images: TwitterImage[]) {
    await this.database.transaction(tx => this.replaceIndex(tx, numberId, images))
  }
  async complete(numberId: string, images: TwitterImage[], date: Date) {
    await this.database.transaction(async tx => {
      await this.replaceIndex(tx, numberId, images)
      await tx.update(booths).set({ twitter_images_updated_at: date }).where(eq(booths.twitter_number_id, numberId))
    })
  }
}
