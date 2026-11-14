import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Configuration } from 'crawlee'
import { catalogOrigin, LoginRequiredError, parseDetail } from './parser.js'
import { collectList } from './list.js'
import { collectDetails } from './details.js'
import { listStoredBoothImages, saveImage } from './images.js'
import type { LoginSession } from './login.js'
import type { CircleListCache, CrawlJob, CrawlStatus, JobRepository } from './types.js'
import type { MapOrganization } from '../booths/organization.js'

export class CrawlerConflictError extends Error {}

interface CrawlerRunners {
  list: typeof collectList
  details: typeof collectDetails
}

export class CrawlerService {
  private job: CrawlJob | null = null
  private initialized = false
  private initializing: Promise<void> | undefined
  private running: Promise<void> | undefined
  private starting: Promise<void> | undefined
  private resetting: Promise<{ deletedBooths: number; deletedImages: number }> | undefined
  private controller: AbortController | undefined
  private writes = Promise.resolve()
  private loginWait: Promise<void> | undefined
  private listCache: CircleListCache | null = null
  private lastPersistedAt = 0
  readonly login: LoginSession
  private readonly repository: JobRepository
  private readonly mediaRoot: string
  private readonly workDirectory: string
  private readonly runners: CrawlerRunners
  private readonly reconcile: ((eventId: string) => Promise<unknown>) | undefined
  private readonly organization: Pick<MapOrganization, 'status' | 'run'> | undefined
  private organizing: Promise<unknown> | undefined

  constructor(
    login: LoginSession,
    repository: JobRepository,
    mediaRoot: string,
    workDirectory: string,
    runners: CrawlerRunners = { list: collectList, details: collectDetails },
    reconcile?: (eventId: string) => Promise<unknown>,
    organization?: Pick<MapOrganization, 'status' | 'run'>,
  ) {
    this.login = login
    this.repository = repository
    this.mediaRoot = mediaRoot
    this.workDirectory = workDirectory
    this.runners = runners
    this.reconcile = reconcile
    this.organization = organization
  }

  private async restore() {
    if (this.initialized) return
    this.initializing ??= (async () => {
      await this.repository.check()
      this.job = await this.repository.load()
      this.listCache = await this.repository.loadList()
      if (this.job && ['listing', 'details', 'waiting_login', 'stopping'].includes(this.job.status)) {
        this.job.status = 'interrupted'
        this.job.action = '服务已重启，请点击继续；未完成的列表将重新读取，已保存详情不会重复添加'
        await this.persist()
      }
      this.initialized = true
    })()
    try { await this.initializing } finally { this.initializing = undefined }
  }

  private persist(force = true) {
    if (!this.job) return Promise.resolve()
    if (!force && Date.now() - this.lastPersistedAt < 1000) return this.writes
    this.lastPersistedAt = Date.now()
    this.job.updatedAt = new Date().toISOString()
    const snapshot = structuredClone(this.job)
    this.writes = this.writes.then(() => this.repository.save(snapshot))
    return this.writes
  }

  async status(): Promise<CrawlStatus> {
    await this.restore()
    const job = this.job
    const failed = Object.keys(job?.failures ?? {}).length
    return {
      id: job?.id ?? null,
      status: this.resetting ? 'resetting' : job?.status ?? 'idle',
      action: this.resetting ? '正在清空 booth 数据、任务进度和图片，请勿关闭服务器' : job?.action ?? '等待开始',
      total: job?.ids.length ?? 0,
      processed: (job?.completedIds.length ?? 0) + failed,
      succeeded: job?.completedIds.length ?? 0,
      failed,
      listComplete: job?.listComplete ?? false,
      comiket: job?.comiket ?? null,
      sample: job?.sample ?? null,
      errors: Object.entries(job?.failures ?? {}).slice(-10).map(([id, message]) => ({ id, message })),
      listCache: this.listCache ? {
        total: this.listCache.ids.length, completedAt: this.listCache.completedAt, comiket: this.listCache.comiket,
      } : null,
      login: this.login.status(),
    }
  }

  get active() { return Boolean(this.starting || this.running || this.resetting || this.organizing) }

  async organizationStatus() {
    if (!this.organization) throw new Error('地图数据整理未配置')
    return { ...await this.organization.status(), organizing: Boolean(this.organizing) }
  }

  organize(kind: 'vacancies' | 'genres') {
    if (this.active) return Promise.reject(new CrawlerConflictError('请等待采集、清空或整理操作完成'))
    if (!this.organization) return Promise.reject(new Error('地图数据整理未配置'))
    this.organizing = this.organization.run(kind).finally(() => { this.organizing = undefined })
    return this.organizing
  }

  start(resume = false, refreshList = false) {
    if (this.active) return Promise.reject(new CrawlerConflictError('采集任务正在运行或正在清空数据'))
    if (resume && refreshList) return Promise.reject(new CrawlerConflictError('刷新列表不能同时继续旧任务'))
    this.starting = this.startTask(resume, refreshList).finally(() => { this.starting = undefined })
    return this.starting
  }

  private async startTask(resume: boolean, refreshList: boolean) {
    await this.restore()
    if (this.running) throw new CrawlerConflictError('采集任务正在运行')
    if (resume && !this.job) throw new CrawlerConflictError('没有可继续的任务')
    this.writes = Promise.resolve()
    if (!resume) {
      const now = new Date().toISOString()
      this.job = {
        id: randomUUID(), status: 'listing', action: '正在准备爬取列表',
        ids: [], completedIds: [], failures: {}, listComplete: false,
        eventId: null, comiket: null, sample: null, startedAt: now, updatedAt: now,
      }
    } else {
      this.job!.failures = {}
      this.job!.status = this.job!.listComplete ? 'details' : 'listing'
      this.job!.action = '正在继续采集'
    }
    if (!this.job!.listComplete && !refreshList && this.listCache) {
      this.job!.ids = [...this.listCache.ids]
      this.job!.eventId = this.listCache.eventId
      this.job!.comiket = this.listCache.comiket
      this.job!.listComplete = true
      this.job!.status = 'details'
      this.job!.action = `使用完整列表缓存，跳过列表读取：${this.job!.ids.length} 个社团`
    }
    await this.persist()
    this.controller = new AbortController()
    this.running = this.execute(this.controller.signal).catch(async (error: unknown) => {
      const stopped = this.controller?.signal.aborted
      console.error(stopped ? 'Crawler interrupted:' : 'Crawler failed:', error)
      this.job!.status = stopped ? 'interrupted' : 'failed'
      this.job!.action = stopped ? '任务已停止，可点击继续' : `采集失败：${error instanceof Error ? error.message : String(error)}`
      this.writes = Promise.resolve()
      await this.persist()
    }).catch((error: unknown) => {
      console.error('Unable to persist crawler failure:', error)
      this.job!.status = 'failed'
      this.job!.action = '保存任务状态失败，请检查数据库连接和服务端日志'
    }).finally(() => { this.running = undefined })
  }

  async stop() {
    if (!this.running) throw new CrawlerConflictError('没有正在运行的任务')
    this.job!.status = 'stopping'
    this.job!.action = '正在停止，等待在途请求退出'
    this.controller!.abort(new Error('用户停止采集'))
    await this.persist()
  }

  reset() {
    if (this.active) return Promise.reject(new CrawlerConflictError('请先停止采集，并等待当前操作完成后再清空'))
    this.resetting = this.resetData().finally(() => { this.resetting = undefined })
    return this.resetting
  }

  private async resetData() {
    await this.restore()
    const files = await listStoredBoothImages(this.mediaRoot)
    const [pending] = await Promise.allSettled([this.writes])
    if (pending.status === 'rejected') console.warn('Pending crawler snapshot failed before reset:', pending.reason)
    this.writes = Promise.resolve()
    const deletedBooths = await this.repository.resetRecords()
    this.job = null
    for (const file of files) await unlink(file)
    return { deletedBooths, deletedImages: files.length }
  }

  private async requireLogin(signal: AbortSignal, invalidate = false) {
    signal.throwIfAborted()
    if (this.loginWait) return this.loginWait
    if (!invalidate && this.login.status().authenticated) return
    this.loginWait = (async () => {
      if (invalidate) this.login.invalidate()
      const phase = this.job!.listComplete ? 'details' : 'listing'
      this.job!.status = 'waiting_login'
      this.job!.action = '等待 Web Catalog 登录：请在登录窗口操作，完成后点击确认登录'
      await this.persist()
      await this.login.waitForLogin(signal)
      signal.throwIfAborted()
      this.job!.status = phase
      this.job!.action = phase === 'listing' ? '登录成功，继续爬取列表' : '登录成功，继续读取详情'
      await this.persist()
    })()
    try { await this.loginWait } finally { this.loginWait = undefined }
  }

  private config(phase: string) {
    return new Configuration({
      persistStorage: false,
      purgeOnStart: false,
      storageClientOptions: { localDataDirectory: join(this.workDirectory, this.job!.id, phase) },
    })
  }

  private async execute(signal: AbortSignal) {
    if (!this.job!.listComplete) {
      await this.requireLogin(signal)
      while (true) {
        signal.throwIfAborted()
        try {
          const result = await this.runners.list({
            login: this.login,
            config: this.config(`list-${randomUUID()}`),
            signal,
            progress: async (ids, eventId, action) => {
              this.job!.ids = ids
              this.job!.eventId = eventId
              this.job!.action = action
              await this.persist()
            },
          })
          this.job!.ids = result.ids
          this.job!.eventId = result.eventId
          this.job!.listComplete = true
          this.listCache = {
            ids: [...result.ids], eventId: result.eventId, comiket: null, completedAt: new Date().toISOString(),
          }
          await this.repository.saveList(this.listCache)
          break
        } catch (error) {
          if (!(error instanceof LoginRequiredError)) throw error
          await this.requireLogin(signal, true)
        }
      }
    }
    signal.throwIfAborted()
    const saved = await this.repository.savedBooths(this.job!.ids)
    for (const record of saved.records) {
      if (this.job!.eventId !== null && record.event_id !== this.job!.eventId) {
        throw new Error('已保存详情活动 ID 与列表缓存不一致，请刷新列表')
      }
      if (this.job!.comiket !== null && record.comiket !== this.job!.comiket) {
        throw new Error('已保存详情 Comiket 届数与列表缓存不一致，请刷新列表')
      }
      this.job!.eventId ??= record.event_id
      this.job!.comiket ??= record.comiket
    }
    this.job!.completedIds = saved.records.map(record => record.id)
    this.job!.sample = saved.sample
    this.job!.failures = {}
    this.job!.status = 'details'
    this.job!.action = `列表已就绪，数据库中已保存 ${saved.records.length} 个，跳过这些记录；详情最多 5 并发、180 次/分钟`
    await this.persist()
    const completed = new Set(this.job!.completedIds)
    const pending = this.job!.ids.filter(id => !completed.has(id))
    if (pending.length) {
      await this.requireLogin(signal)
      await this.details(pending, signal)
    }
    signal.throwIfAborted()
    const failed = Object.keys(this.job!.failures).length
    if (this.job!.completedIds.length + failed !== this.job!.ids.length) {
      throw new Error('部分详情未处理完成，请点击继续；任务不会被标记为成功')
    }
    this.job!.status = failed ? 'failed' : 'completed'
    if (!failed && this.reconcile && this.job!.eventId) {
      this.job!.status = 'details'
      this.job!.action = '社团采集完成，正在整理地图空位范围和 genre'
      await this.persist()
      await this.reconcile(this.job!.eventId)
      signal.throwIfAborted()
      this.job!.status = 'completed'
    }
    this.job!.action = failed
      ? `采集结束，${failed} 个社团失败；点击继续重试失败项`
      : `采集完成，已保存 ${this.job!.completedIds.length} 个社团及对应图片`
    await this.persist()
  }

  private async details(ids: string[], signal: AbortSignal) {
    await this.runners.details({
      requests: ids.map(id => ({ id, url: `${catalogOrigin}/Circle/${id}` })),
      login: this.login,
      config: this.config(`details-${randomUUID()}`),
      signal,
      beforeRequest: async () => { if (this.loginWait) await this.loginWait },
      loginRequired: async generation => {
        if (generation === this.login.generation) await this.requireLogin(signal, true)
      },
      process: async (id, html) => {
        const { booth, images } = parseDetail(html, id)
        if (this.job!.eventId !== null && booth.event_id !== this.job!.eventId) throw new Error('详情活动 ID 与列表不一致')
        this.job!.eventId ??= booth.event_id
        if (this.job!.comiket !== null && booth.comiket !== this.job!.comiket) {
          throw new Error('详情 Comiket 届数不一致')
        }
        this.job!.comiket = booth.comiket
        if (this.listCache && (this.listCache.eventId === null || this.listCache.comiket === null)) {
          this.listCache.eventId = booth.event_id
          this.listCache.comiket = booth.comiket
          await this.repository.saveList(this.listCache)
        }
        const names: string[] = []
        for (const image of images) {
          names.push(await saveImage(image, booth.comiket, this.mediaRoot, this.login, signal))
        }
        signal.throwIfAborted()
        booth.images = JSON.stringify(names)
        await this.repository.saveBooth(booth)
        if (!this.job!.completedIds.includes(id)) this.job!.completedIds.push(id)
        delete this.job!.failures[id]
        this.job!.sample ??= booth
        if (this.job!.status !== 'waiting_login') {
          this.job!.action = `正在读取详情：${this.job!.completedIds.length}/${this.job!.ids.length} 个已读取社团；刚保存 ${id}`
        }
        await this.persist(false)
      },
      failed: async (id, error) => {
        this.job!.failures[id] = error.message
        console.error(`Booth ${id} failed after retries:`, error.message)
        await this.persist(false)
      },
    })
  }

  async close() {
    await this.starting
    await this.resetting
    await this.organizing
    this.controller?.abort(new Error('Server shutting down'))
    await this.running
    await this.login.close()
  }
}
