import type { PixivStore } from './repository.js'
import { PIXIV_IMAGE_LIMIT, PixivAccessError, newestFirst, validPixivId } from './source.js'
import type { PixivSource } from './source.js'
import { PixivStorage } from './storage.js'
import { LiveImages } from '../liveImages.js'
export { ImageTokenError as PixivImageTokenError } from '../liveImages.js'

export const PIXIV_MIN_UPDATE_INTERVAL = 60 * 60 * 1000
export class PixivConflictError extends Error {}
export interface PixivJobStatus {
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  total: number
  completed: number
  updated: number
  skipped: number
  failed: number
  message: string | null
}
interface Job { state: PixivJobStatus; task: Promise<void> }
const idle = (): PixivJobStatus => ({ status: 'idle', total: 0, completed: 0, updated: 0, skipped: 0, failed: 0, message: null })

export class PixivService {
  private readonly store: PixivStore
  private readonly source: PixivSource
  readonly storage: PixivStorage
  private readonly now: () => Date
  private readonly controller = new AbortController()
  private readonly jobs = new Map<string, Job>()
  private active = false
  private readonly artists = new Map<string, Promise<'updated' | 'skipped'>>()
  private readonly live: LiveImages

  constructor(store: PixivStore, source: PixivSource, storage: PixivStorage, now = () => new Date()) {
    this.store = store; this.source = source; this.storage = storage; this.now = now
    this.live = new LiveImages('pixiv', storage, (url, signal) => {
      if (!source.download) throw new Error('Pixiv 数据源不支持图片转发')
      return source.download(url, signal)
    }, this.controller.signal, now)
  }

  status(userId: string) {
    const state = this.jobs.get(userId)?.state ?? idle()
    return {
      ...state, busy: this.active,
      warning: state.status === 'running' ? this.source.warning?.() ?? null : null,
      retry: state.status === 'running' ? this.source.retryStatus?.() ?? null : null,
    }
  }

  async gallery(id: string) {
    const booth = await this.store.booth(id)
    if (!booth) return null
    if (!booth.pixivId) return { pixivId: null, updatedAt: null, images: [], missingCount: 0 }
    if (!validPixivId(booth.pixivId)) throw new Error('社团的 Pixiv 用户 ID 无效')
    const ids = newestFirst(await this.store.images(booth.pixivId)).slice(0, PIXIV_IMAGE_LIMIT)
    const files = await this.storage.list(booth.pixivId)
    const images = ids.flatMap(id => {
      const file = files.find(file => file.id === id)
      if (!file) return []
      return [{ id, url: `/api/social/pixiv/images/${booth.pixivId}/${file.name}` }]
    })
    return { pixivId: booth.pixivId, updatedAt: booth.updatedAt?.toISOString() ?? null, images, missingCount: ids.length - images.length }
  }

  async liveGallery(id: string, signal: AbortSignal) {
    const booth = await this.store.booth(id)
    if (!booth) return null
    if (!booth.pixivId) return { pixivId: null, updatedAt: null, images: [], missingCount: 0 }
    if (!this.source.latestImages || !this.source.download) throw new Error('Pixiv 数据源不支持即时预览')
    const combined = AbortSignal.any([signal, this.controller.signal])
    const [works, files] = await Promise.all([
      this.source.latestImages(booth.pixivId, combined), this.storage.list(booth.pixivId),
    ])
    combined.throwIfAborted()
    const ids = works.map(work => work.id)
    if (ids.length > PIXIV_IMAGE_LIMIT || new Set(ids).size !== ids.length || !ids.every(validPixivId)) {
      throw new Error('Pixiv 最新作品列表无效')
    }
    await this.store.replace(booth.pixivId, ids)
    return { pixivId: booth.pixivId, updatedAt: this.now().toISOString(), ...this.live.manifest(booth.pixivId, works, files) }
  }

  liveImage(token: string) { return this.live.image(token) }

  async checkBooth(id: string): Promise<'updated' | 'skipped'> {
    const booth = await this.store.booth(id)
    if (!booth?.pixivId || !validPixivId(booth.pixivId)) throw new Error('社团不存在或 Pixiv 用户 ID 无效')
    const existing = this.artists.get(booth.pixivId)
    if (existing) return existing
    const task = this.collect(booth.pixivId, booth.updatedAt)
    this.artists.set(booth.pixivId, task)
    try { return await task } finally { this.artists.delete(booth.pixivId) }
  }

  private async collect(pixivId: string, updatedAt: Date | null): Promise<'updated' | 'skipped'> {
    const signal = this.controller.signal
    signal.throwIfAborted()
    const files = await this.storage.list(pixivId)
    if (!updatedAt && files.length && !(await this.store.images(pixivId)).length) {
      const restored = newestFirst(files.map(file => file.id)).slice(0, PIXIV_IMAGE_LIMIT)
      updatedAt = new Date(Math.max(...files.filter(file => restored.includes(file.id)).map(file => file.modifiedAt.getTime())))
      await this.store.replace(pixivId, restored)
      await this.storage.prune(pixivId, restored)
      await this.store.touch(pixivId, updatedAt)
    }
    if (updatedAt && this.now().getTime() - updatedAt.getTime() < PIXIV_MIN_UPDATE_INTERVAL) return 'skipped'
    const latest = await this.source.latest(pixivId, signal)
    if (latest.length > PIXIV_IMAGE_LIMIT || new Set(latest).size !== latest.length || !latest.every(validPixivId)) {
      throw new Error('Pixiv 最新作品列表无效')
    }
    const staged: Awaited<ReturnType<PixivStorage['stage']>>[] = []
    const pending = latest.filter(id => !files.some(file => file.id === id))
    let next = 0
    let stopped = false
    const worker = async () => {
      try {
        while (!stopped && next < pending.length) {
          signal.throwIfAborted()
          const id = pending[next++]!
          const image = await this.source.image(pixivId, id, signal)
          staged.push(await this.storage.stage(pixivId, id, image.body, image.extension))
        }
      } catch (error) {
        stopped = true
        throw error
      }
    }
    try {
      // Wait for every worker before cleanup; an in-flight download may still stage a file.
      const results = await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, worker))
      const failures = results.filter(result => result.status === 'rejected')
      const failure = failures.find(result => result.reason instanceof PixivAccessError) ?? failures[0]
      if (failure) throw failure.reason
      signal.throwIfAborted()
      for (const file of staged) await file.commit()
      await this.store.replace(pixivId, latest)
      await this.storage.prune(pixivId, latest)
      await this.store.touch(pixivId, this.now())
      return 'updated'
    } finally {
      for (const file of staged) await file.clean()
    }
  }

  start(userId: string, missingOnly: boolean) {
    if (this.controller.signal.aborted) throw new PixivConflictError('服务正在关闭')
    if (this.active) throw new PixivConflictError('已有 Pixiv 图片任务正在执行，请稍后重试')
    this.jobs.clear()
    const job: Job = { state: { ...idle(), status: 'running' }, task: Promise.resolve() }
    this.jobs.set(userId, job)
    this.active = true
    job.task = this.run(userId, missingOnly, job)
  }

  private async run(userId: string, missingOnly: boolean, job: Job) {
    try {
      const ids = await this.store.favorites(userId, missingOnly)
      job.state.total = ids.length
      for (const id of ids) {
        this.controller.signal.throwIfAborted()
        try {
          const result = await this.checkBooth(id)
          job.state[result]++
        } catch (error) {
          job.state.failed++
          if (error instanceof PixivAccessError) throw error
          console.error('Pixiv booth crawl failed:', id, error)
          job.state.message = error instanceof Error ? error.message : 'Pixiv 图片采集失败，请检查服务端日志'
        } finally { job.state.completed++ }
      }
      job.state.status = job.state.failed ? 'failed' : 'succeeded'
    } catch (error) {
      console.error('Pixiv image job failed:', error)
      job.state.status = 'failed'
      job.state.message = error instanceof Error ? error.message : 'Pixiv 图片任务失败，请检查服务端日志'
    } finally { this.active = false }
  }

  async close() {
    this.controller.abort(new Error('服务正在关闭，Pixiv 图片任务已停止'))
    await Promise.all([...this.jobs.values()].map(job => job.task))
    await Promise.allSettled(this.artists.values())
    await this.live.close()
    await this.source.close?.()
  }
}
