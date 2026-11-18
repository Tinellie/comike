import { PixivStorage } from '../pixiv/storage.js'
import { validPixivId } from '../pixiv/source.js'
import { PIXIV_MIN_UPDATE_INTERVAL, PixivConflictError } from '../pixiv/service.js'
import type { PixivJobStatus } from '../pixiv/service.js'
import type { TwitterStore } from './repository.js'
import { TwitterAccessError } from './source.js'
import type { TwitterSource } from './source.js'
import { LiveImages } from '../liveImages.js'

const idle = (): PixivJobStatus => ({ status: 'idle', total: 0, completed: 0, updated: 0, skipped: 0, failed: 0, message: null })
export class TwitterService {
  private readonly controller = new AbortController()
  private readonly jobs = new Map<string, { state: PixivJobStatus; task: Promise<void> }>()
  private active = false
  private readonly store: TwitterStore
  private readonly source: TwitterSource
  readonly storage: PixivStorage
  private readonly now: () => Date
  private readonly live: LiveImages
  constructor(
    store: TwitterStore, source: TwitterSource, storage: PixivStorage, now = () => new Date(),
  ) {
    this.store = store; this.source = source; this.storage = storage; this.now = now
    this.live = new LiveImages('twitter', storage, (url, signal) => source.download(url, signal), this.controller.signal, now)
  }
  status(userId: string) { return { ...(this.jobs.get(userId)?.state ?? idle()), busy: this.active, warning: null, retry: null } }
  async gallery(id: string) {
    const booth = await this.store.booth(id)
    if (!booth) return null
    if (!booth.numberId) return { images: [], missingCount: 0 }
    const [ids, files] = await Promise.all([this.store.images(booth.numberId), this.storage.list(booth.numberId)])
    const images = ids.slice(0, 10).flatMap(id => {
      const file = files.find(file => file.id === id)
      return file ? [{ id, url: `/api/social/twitter/images/${booth.numberId}/${file.name}` }] : []
    })
    return { images, missingCount: ids.length - images.length }
  }
  async liveGallery(id: string, signal: AbortSignal) {
    let booth = await this.store.booth(id)
    if (!booth) return null
    if (!booth.username) return { images: [], missingCount: 0 }
    const combined = AbortSignal.any([signal, this.controller.signal])
    let numberId = booth.numberId
    if (!numberId) {
      numberId = await this.source.resolve(booth.username, combined)
      combined.throwIfAborted()
      await this.store.resolve(booth.username, numberId)
      booth = await this.store.booth(id)
      if (booth?.numberId !== numberId) throw new Error('社团 Twitter 账号已变更，请重试')
    }
    if (!validPixivId(numberId)) throw new Error('Twitter 数字 ID 无效')
    const [works, files] = await Promise.all([this.source.latest(numberId, combined), this.storage.list(numberId)])
    combined.throwIfAborted()
    const ids = works.map(work => work.id)
    if (ids.length > 10 || new Set(ids).size !== ids.length || !ids.every(validPixivId)) throw new Error('Twitter 图片列表无效')
    await this.store.replace(numberId, works)
    return this.live.manifest(numberId, works, files)
  }
  liveImage(token: string) { return this.live.image(token) }
  async checkBooth(id: string) {
    const signal = this.controller.signal
    signal.throwIfAborted()
    let booth = await this.store.booth(id)
    if (!booth?.username) throw new Error('社团不存在或没有 Twitter 用户名')
    let numberId = booth.numberId
    if (!numberId) {
      numberId = await this.source.resolve(booth.username, signal)
      await this.store.resolve(booth.username, numberId)
      booth = await this.store.booth(id)
      if (booth?.numberId !== numberId) throw new Error('社团 Twitter 账号已变更，请重试')
    }
    if (!validPixivId(numberId)) throw new Error('Twitter 数字 ID 无效')
    if (booth?.updatedAt && this.now().getTime() - booth.updatedAt.getTime() < PIXIV_MIN_UPDATE_INTERVAL) return 'skipped'
    const [latest, files] = await Promise.all([this.source.latest(numberId, signal), this.storage.list(numberId)])
    const ids = latest.map(image => image.id)
    if (ids.length > 10 || new Set(ids).size !== ids.length || !ids.every(validPixivId)) throw new Error('Twitter 图片列表无效')
    const pending = latest.filter(image => !files.some(file => file.id === image.id))
    const staged: Awaited<ReturnType<PixivStorage['stage']>>[] = []
    let next = 0, stopped = false
    const worker = async () => {
      try {
        while (!stopped && next < pending.length) {
          signal.throwIfAborted()
          const work = pending[next++]!
          const image = await this.source.download(work.url, signal)
          staged.push(await this.storage.stage(numberId, work.id, image.body, image.extension))
        }
      } catch (error) { stopped = true; throw error }
    }
    try {
      const results = await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, worker))
      const failures = results.filter(result => result.status === 'rejected')
      const failure = failures.find(result => result.reason instanceof TwitterAccessError) ?? failures[0]
      if (failure) throw failure.reason
      signal.throwIfAborted()
      for (const image of staged) await image.commit()
      await this.store.complete(numberId, latest, this.now())
      await this.storage.prune(numberId, ids)
      return 'updated'
    } finally { for (const image of staged) await image.clean() }
  }
  start(userId: string, missingOnly: boolean) {
    if (this.active || this.controller.signal.aborted) throw new PixivConflictError('Twitter 图片任务正在执行或服务正在关闭')
    this.jobs.clear()
    const job: { state: PixivJobStatus; task: Promise<void> } = { state: { ...idle(), status: 'running' }, task: Promise.resolve() }
    this.jobs.set(userId, job); this.active = true
    job.task = (async () => {
      try {
        const ids = await this.store.favorites(userId, missingOnly)
        job.state.total = ids.length
        for (const id of ids) {
          this.controller.signal.throwIfAborted()
          try { job.state[await this.checkBooth(id)]++ } catch (error) {
            job.state.failed++
            if (error instanceof TwitterAccessError) throw error
            console.error('Twitter booth crawl failed:', id, error)
            job.state.message = error instanceof Error ? error.message : 'Twitter 图片采集失败'
          } finally { job.state.completed++ }
        }
        job.state.status = job.state.failed ? 'failed' : 'succeeded'
      } catch (error) {
        console.error('Twitter image job failed:', error)
        job.state.status = 'failed'
        job.state.message = error instanceof Error ? error.message : 'Twitter 图片任务失败'
      } finally { this.active = false }
    })()
  }
  async close() {
    this.controller.abort()
    await Promise.all([...this.jobs.values()].map(job => job.task))
    await this.live.close()
    await this.source.close?.()
  }
}
