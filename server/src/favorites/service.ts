import type { BrowserInput, RemoteLogin } from '../crawler/login.js'
import { LoginRequiredError } from '../crawler/parser.js'
import type { Favorite } from './parser.js'
import type { FavoritesStore } from './repository.js'
import { collectFavorites } from './source.js'

export type ImportLogin = Pick<RemoteLogin, 'status' | 'waitForLogin' | 'open' | 'confirm' | 'input' | 'screenshot' | 'invalidate' | 'logout' | 'clear' | 'withPage'>
export interface ImportStatus {
  status: 'idle' | 'waiting_login' | 'crawling' | 'logging_out' | 'saving' | 'succeeded' | 'failed' | 'cancelled'
  page: number
  pages: number
  imported: number
  message: string | null
  login: ReturnType<RemoteLogin['status']>
}
interface Job {
  status: ImportStatus
  login: ImportLogin
  controller: AbortController
  task: Promise<void>
  active: boolean
  updatedAt: number
}

export class ImportConflictError extends Error {}

export class FavoritesService {
  private jobs = new Map<string, Job>()
  private closing = false
  private readonly store: FavoritesStore
  private readonly createLogin: () => ImportLogin
  private readonly collect: (login: ImportLogin, signal: AbortSignal, progress: (page: number, pages: number, count: number) => void) => Promise<Favorite[]>
  private readonly timeoutMs: number

  constructor(
    store: FavoritesStore,
    createLogin: () => ImportLogin,
    collect = collectFavorites,
    timeoutMs = 15 * 60 * 1000,
  ) {
    this.store = store
    this.createLogin = createLogin
    this.collect = collect
    this.timeoutMs = timeoutMs
  }

  async status(userId: string) {
    this.prune()
    const job = this.jobs.get(userId)
    const status: ImportStatus = job ? { ...job.status, login: job.login.status() } : {
      status: 'idle', page: 0, pages: 0, imported: 0, message: null,
      login: { open: false, authenticated: false, width: 1280, height: 800 },
    }
    return { ...status, savedCount: await this.store.count(userId) }
  }

  start(userId: string) {
    this.prune()
    if (this.closing) throw new ImportConflictError('服务正在关闭')
    if (this.jobs.get(userId)?.active) throw new ImportConflictError('你的收藏导入正在进行中')
    if ([...this.jobs.values()].filter(job => job.active).length >= 4) {
      throw new ImportConflictError('当前导入人数较多，请稍后重试')
    }
    const login = this.createLogin()
    const job: Job = {
      login, controller: new AbortController(), task: Promise.resolve(), active: true, updatedAt: Date.now(),
      status: { status: 'waiting_login', page: 0, pages: 0, imported: 0, message: null, login: login.status() },
    }
    this.jobs.set(userId, job)
    job.task = this.run(userId, job)
  }

  private async run(userId: string, job: Job) {
    const timeout = setTimeout(() => job.controller.abort(new Error('导入超时，请重新开始并及时完成 Circle.ms 登录')), this.timeoutMs)
    timeout.unref()
    const signal = job.controller.signal
    let entries: Favorite[] | undefined
    let failure: unknown
    try {
      await this.store.count(userId)
      await job.login.waitForLogin(signal)
      for (;;) {
        signal.throwIfAborted()
        job.status.status = 'crawling'
        try {
          entries = await this.collect(job.login, signal, (page, pages, count) => {
            job.status.page = page; job.status.pages = pages; job.status.imported = count
          })
          break
        } catch (error) {
          if (!(error instanceof LoginRequiredError) || signal.aborted) throw error
          job.login.invalidate()
          job.status.status = 'waiting_login'
          job.status.page = 0; job.status.pages = 0; job.status.imported = 0
          await job.login.waitForLogin(signal)
        }
      }
    } catch (error) {
      failure = signal.aborted ? signal.reason : error
    } finally {
      job.status.status = 'logging_out'
      try { await job.login.logout() } catch (error) {
        console.error('Favorites Circle.ms logout failed:', error)
        failure = new Error('Circle.ms 退出失败，导入未保存；本地浏览器会话已清理，请在 Circle.ms 检查登录状态')
      }
      try { await job.login.clear() } catch (error) {
        console.error('Favorites browser cleanup failed:', error)
        failure = new Error('导入浏览器清理失败，导入未保存，请联系管理员')
      }
    }
    try {
      if (failure) throw failure
      signal.throwIfAborted()
      if (!entries) throw new Error('收藏导入未获得完整结果')
      job.status.status = 'saving'
      await this.store.replace(userId, entries)
      job.status.status = 'succeeded'
      job.status.message = `已同步 ${entries.length} 条收藏，并退出 Circle.ms`
    } catch (error) {
      console.error('Favorites import failed:', error)
      job.status.status = signal.aborted && (!failure || failure === signal.reason) ? 'cancelled' : 'failed'
      job.status.message = error instanceof Error ? error.message : '收藏导入失败，原有收藏保持不变'
    } finally {
      clearTimeout(timeout)
      job.active = false
      job.updatedAt = Date.now()
    }
  }

  private prune() {
    for (const [userId, job] of this.jobs) {
      if (!job.active && Date.now() - job.updatedAt > 60 * 60 * 1000) this.jobs.delete(userId)
    }
  }

  private waitingJob(userId: string) {
    const job = this.jobs.get(userId)
    if (!job?.active || job.status.status !== 'waiting_login' || job.controller.signal.aborted) {
      throw new ImportConflictError('当前没有等待登录的导入任务')
    }
    return job
  }

  async openLogin(userId: string) { await this.waitingJob(userId).login.open() }
  async confirmLogin(userId: string) { await this.waitingJob(userId).login.confirm() }
  async input(userId: string, input: BrowserInput) { await this.waitingJob(userId).login.input(input) }
  async screenshot(userId: string) { return this.waitingJob(userId).login.screenshot() }
  loginStatus(userId: string) {
    return this.jobs.get(userId)?.login.status() ?? {
      open: false, authenticated: false, width: 1280, height: 800,
    }
  }

  stop(userId: string) {
    const job = this.jobs.get(userId)
    if (!job?.active || ['logging_out', 'saving'].includes(job.status.status)) {
      throw new ImportConflictError('没有可停止的导入任务')
    }
    job.controller.abort(new Error('已停止导入，原有收藏保持不变'))
  }

  async close() {
    this.closing = true
    for (const job of this.jobs.values()) {
      if (job.active) job.controller.abort(new Error('服务正在关闭，原有收藏保持不变'))
    }
    await Promise.all([...this.jobs.values()].map(job => job.task))
  }
}
