import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validPixivId } from './pixiv/source.js'
import type { PixivStorage, StoredPixivImage } from './pixiv/storage.js'

export class ImageTokenError extends Error {}
interface Image { body: Buffer; extension: string }

export class LiveImages {
  private readonly imageKey = randomBytes(32)
  private readonly downloads = new Map<string, Promise<Image>>()
  private readonly saves = new Set<Promise<void>>()
  private imageRequests = 0
  private readonly queue: (() => void)[] = []
  private readonly provider: 'pixiv' | 'twitter'
  private readonly storage: PixivStorage
  private readonly download: (url: string, signal: AbortSignal) => Promise<Image>
  private readonly signal: AbortSignal
  private readonly now: () => Date

  constructor(
    provider: 'pixiv' | 'twitter', storage: PixivStorage,
    download: (url: string, signal: AbortSignal) => Promise<Image>,
    signal: AbortSignal, now: () => Date,
  ) {
    this.provider = provider; this.storage = storage; this.download = download; this.signal = signal; this.now = now
  }

  manifest(artistId: string, works: { id: string; url: string }[], files: StoredPixivImage[]) {
    let missingCount = 0
    const images = works.map(work => {
      const file = files.find(file => file.id === work.id)
      if (file) return { id: work.id, url: `/api/social/${this.provider}/images/${artistId}/${file.name}` }
      missingCount++
      const payload = Buffer.from(JSON.stringify({
        artistId, imageId: work.id, url: work.url, expires: this.now().getTime() + 15 * 60_000,
      })).toString('base64url')
      const signature = createHmac('sha256', this.imageKey).update(payload).digest('base64url')
      return { id: work.id, url: `/api/social/${this.provider}/live/images/${payload}.${signature}` }
    })
    return { images, missingCount }
  }

  async image(token: string) {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra || token.length > 4096) throw new ImageTokenError('图片链接无效，请重新打开详情')
    const expected = createHmac('sha256', this.imageKey).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ImageTokenError('图片链接无效，请重新打开详情')
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (!value || typeof value !== 'object' || !('artistId' in value) || typeof value.artistId !== 'string'
      || !validPixivId(value.artistId) || !('imageId' in value) || typeof value.imageId !== 'string'
      || !validPixivId(value.imageId) || !('url' in value) || typeof value.url !== 'string'
      || !('expires' in value) || typeof value.expires !== 'number' || value.expires <= this.now().getTime()) {
      throw new ImageTokenError('图片链接已失效，请重新打开详情')
    }
    const { artistId, imageId, url } = value
    const key = `${artistId}:${imageId}`
    const existing = this.downloads.get(key)
    if (existing) return existing
    const task = this.load(artistId, imageId, url)
    this.downloads.set(key, task)
    return task
  }

  private async load(artistId: string, imageId: string, url: string) {
    const key = `${artistId}:${imageId}`
    if (this.imageRequests >= 3) await new Promise<void>(resolve => this.queue.push(resolve))
    else this.imageRequests++
    try {
      this.signal.throwIfAborted()
      const file = (await this.storage.list(artistId)).find(file => file.id === imageId)
      if (file) {
        const image = { body: await readFile(join(this.storage.directory(artistId), file.name)), extension: file.name.split('.').at(-1)! }
        this.downloads.delete(key)
        return image
      }
      const image = await this.download(url, this.signal)
      const save = this.save(artistId, imageId, image)
        .catch((error: unknown) => { console.error(`${this.provider} background image cache failed:`, imageId, error) })
      this.saves.add(save)
      void save.finally(() => { this.saves.delete(save); this.downloads.delete(key) })
      return image
    } catch (error) {
      this.downloads.delete(key)
      throw error
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.imageRequests--
    }
  }

  private async save(artistId: string, imageId: string, image: Image) {
    const staged = await this.storage.stage(artistId, imageId, image.body, image.extension)
    try { await staged.commit() } finally { await staged.clean() }
  }

  async close() {
    await Promise.allSettled(this.downloads.values())
    await Promise.all(this.saves)
  }
}
