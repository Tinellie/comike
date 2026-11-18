import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { socialImageLists } from '../db/schema.js'
import { validPixivId } from './pixiv/source.js'

export const IMAGE_LIST_INTERVAL = 10 * 60_000
export type ImageProvider = 'pixiv' | 'twitter'
export interface ListImage {
  id: string
  url: string
  tweetId?: string
  publishedAt?: string
  mediaIndex?: number
}
export interface ImageList { images: ListImage[]; checkedAt: Date }
export interface ImageListStore {
  read(provider: ImageProvider, artistId: string): Promise<ImageList | null>
  save(provider: ImageProvider, artistId: string, list: ImageList): Promise<void>
}

function decodeImages(provider: ImageProvider, value: unknown): ListImage[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error(`${provider} 图片列表无效`)
  const images = value.map((image: unknown): ListImage => {
    if (!image || typeof image !== 'object' || !('id' in image) || typeof image.id !== 'string'
      || !validPixivId(image.id) || !('url' in image) || typeof image.url !== 'string') throw new Error(`${provider} 图片列表条目无效`)
    const url = new URL(image.url)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${provider} 图片地址无效`)
    if (provider === 'pixiv') return { id: image.id, url: image.url }
    if (!('tweetId' in image) || typeof image.tweetId !== 'string' || !validPixivId(image.tweetId)
      || !('publishedAt' in image) || typeof image.publishedAt !== 'string' || !Number.isFinite(Date.parse(image.publishedAt))
      || !('mediaIndex' in image) || typeof image.mediaIndex !== 'number' || !Number.isInteger(image.mediaIndex) || image.mediaIndex < 0) {
      throw new Error('Twitter 图片发布时间或附件顺序无效')
    }
    return { id: image.id, url: image.url, tweetId: image.tweetId, publishedAt: image.publishedAt, mediaIndex: image.mediaIndex }
  })
  if (new Set(images.map(image => image.id)).size !== images.length) throw new Error(`${provider} 图片列表存在重复条目`)
  return images
}

export class MysqlImageListStore implements ImageListStore {
  private get database() {
    if (!db) throw new Error('DATABASE_URL is not configured')
    return db
  }
  async read(provider: ImageProvider, artistId: string) {
    const [row] = await this.database.select().from(socialImageLists)
      .where(and(eq(socialImageLists.provider, provider), eq(socialImageLists.artist_id, artistId))).limit(1)
    return row ? { images: decodeImages(provider, row.images), checkedAt: row.checked_at } : null
  }
  async save(provider: ImageProvider, artistId: string, list: ImageList) {
    await this.database.insert(socialImageLists)
      .values({ provider, artist_id: artistId, images: list.images, checked_at: list.checkedAt })
      .onDuplicateKeyUpdate({ set: { images: list.images, checked_at: list.checkedAt } })
  }
}

export class ImageLists {
  private readonly pending = new Map<string, Promise<ImageList & { refreshed: boolean }>>()
  private readonly provider: ImageProvider
  private readonly store: ImageListStore
  private readonly fetch: (artistId: string) => Promise<ListImage[]>
  private readonly now: () => Date

  constructor(provider: ImageProvider, store: ImageListStore, fetch: (artistId: string) => Promise<ListImage[]>, now: () => Date) {
    this.provider = provider; this.store = store; this.fetch = fetch; this.now = now
  }
  async get(artistId: string) {
    const existing = this.pending.get(artistId)
    if (existing) return existing
    const task = this.load(artistId)
    this.pending.set(artistId, task)
    try { return await task } finally { this.pending.delete(artistId) }
  }
  private isFresh(cached: ImageList | null): cached is ImageList {
    return cached !== null && this.now().getTime() - cached.checkedAt.getTime() <= IMAGE_LIST_INTERVAL
  }
  async needsRefresh(artistId: string) {
    return !this.isFresh(await this.store.read(this.provider, artistId))
  }
  private async load(artistId: string) {
    const cached = await this.store.read(this.provider, artistId)
    if (this.isFresh(cached)) {
      return { ...cached, refreshed: false }
    }
    const images = decodeImages(this.provider, await this.fetch(artistId))
    const list = { images, checkedAt: this.now() }
    await this.store.save(this.provider, artistId, list)
    return { ...list, refreshed: true }
  }
  async close() { await Promise.allSettled(this.pending.values()) }
}
