import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { catalogOrigin, isLoginPage, listUrl, LoginRequiredError } from './parser.js'
import type { CrawlStatus } from './types.js'

export type BrowserInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'wheel'; deltaY: number }

export type LoginSession = Pick<RemoteLogin,
  'status' | 'generation' | 'open' | 'confirm' | 'invalidate' | 'waitForLogin' | 'storageState'
  | 'cookieHeader' | 'screenshot' | 'input' | 'clear' | 'close'>

export class RemoteLogin {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private page: Page | undefined
  private opening: Promise<void> | undefined
  private navigating: Promise<void> | undefined
  private confirming: Promise<void> | undefined
  private authenticated = false
  private visible = false
  private lastError: string | null = null
  private version = 0
  private listeners = new Set<() => void>()
  readonly width = 1280
  readonly height = 800
  private readonly stateFile: string | undefined
  private readonly launchBrowser: () => Promise<Browser>
  private backgroundOperations = 0
  private readonly entryUrl: string
  private readonly authenticatedSelector: string

  constructor(stateFile: string | undefined, launchBrowser = () => chromium.launch({ headless: true }),
    entryUrl = listUrl, authenticatedSelector = '#m-section-body') {
    this.stateFile = stateFile
    this.launchBrowser = launchBrowser
    this.entryUrl = entryUrl
    this.authenticatedSelector = authenticatedSelector
  }

  status(): CrawlStatus['login'] {
    return {
      open: this.visible, authenticated: this.authenticated,
      opening: Boolean(this.navigating), error: this.lastError,
      width: this.width, height: this.height,
    }
  }

  get generation() { return this.version }

  private async ensureBrowser() {
    if (this.opening) return this.opening
    if (this.context) return
    this.opening ??= (async () => {
      if (this.stateFile) await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 })
      this.browser = await this.launchBrowser()
      this.context = await this.browser.newContext({
        viewport: { width: this.width, height: this.height },
        ...(this.stateFile && existsSync(this.stateFile) ? { storageState: this.stateFile } : {}),
      })
      await this.context.route('**/*', async route => {
        const request = route.request()
        if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
          const host = new URL(request.url()).hostname
          if (host !== 'circle.ms' && !host.endsWith('.circle.ms')) {
            console.warn('Blocked remote browser navigation outside circle.ms:', host)
            await route.abort()
            return
          }
        }
        await route.fallback()
      })
      this.context.on('page', page => { if (!this.confirming && !this.backgroundOperations) this.page = page })
      this.page = await this.context.newPage()
    })()
    try {
      await this.opening
    } catch (error) {
      await this.browser?.close()
      this.browser = undefined
      this.context = undefined
      this.page = undefined
      throw error
    } finally {
      this.opening = undefined
    }
  }

  open(): Promise<void> {
    if (this.navigating) return this.navigating
    if (this.visible && this.page && !this.page.isClosed()) return Promise.resolve()
    this.visible = true
    this.lastError = null
    this.navigating = (async () => {
      await this.ensureBrowser()
      if (!this.page || this.page.isClosed()) this.page = await this.context!.newPage()
      const response = await this.page.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (response && response.status() >= 500) throw new Error(`登录网站暂时不可用（HTTP ${response.status()}）`)
    })().catch((error: unknown) => {
      this.visible = false
      this.lastError = error instanceof Error ? error.message : '无法启动远程登录浏览器'
      console.error('Remote login browser opening failed:', error)
      throw error
    }).finally(() => { this.navigating = undefined })
    return this.navigating
  }

  confirm() {
    this.confirming ??= this.verifyLogin().finally(() => { this.confirming = undefined })
    return this.confirming
  }

  private async verifyLogin() {
    await this.ensureBrowser()
    const probe = await this.context!.newPage()
    try {
      const response = await probe.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (!response) throw new Error('登录验证没有收到网页响应')
      if ([401, 403].includes(response.status()) || isLoginPage(probe.url(), await probe.content())) throw new LoginRequiredError()
      if (!response.ok()) throw new Error(`登录验证失败：HTTP ${response.status()}`)
      await probe.locator(this.authenticatedSelector).waitFor({ state: 'attached', timeout: 15_000 })
      if (this.stateFile) {
        const temporary = `${this.stateFile}.tmp`
        await this.context!.storageState({ path: temporary })
        await chmod(temporary, 0o600)
        await rename(temporary, this.stateFile)
      }
      this.authenticated = true
      this.visible = false
      this.version++
      for (const listener of this.listeners) listener()
    } finally {
      await probe.close()
      this.page = this.context!.pages().at(-1)
    }
  }

  invalidate() {
    this.authenticated = false
    this.visible = false
    this.lastError = null
  }

  async waitForLogin(signal: AbortSignal) {
    if (this.authenticated) return
    signal.throwIfAborted()
    if (this.version === 0 && !this.visible && this.stateFile && existsSync(this.stateFile)) {
      try {
        await this.confirm()
        return
      } catch (error) {
        if (!(error instanceof LoginRequiredError)) throw error
        console.info('Saved Web Catalog session expired; interactive login is required')
      }
    }
    if (!this.visible) await this.open()
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.listeners.delete(done)
        signal.removeEventListener('abort', aborted)
      }
      const done = () => { cleanup(); resolve() }
      const aborted = () => { cleanup(); reject(signal.reason) }
      this.listeners.add(done)
      signal.addEventListener('abort', aborted, { once: true })
      if (this.authenticated) done()
    })
  }

  async storageState() {
    await this.ensureBrowser()
    return this.context!.storageState()
  }

  async cookieHeader(url: string) {
    await this.ensureBrowser()
    return (await this.context!.cookies(url)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }

  async screenshot() {
    if (!this.visible || !this.page || this.page.isClosed()) throw new Error('登录窗口未打开')
    return this.page.screenshot({ type: 'jpeg', quality: 65, timeout: 10_000 })
  }

  async input(input: BrowserInput) {
    if (!this.visible || !this.page || this.page.isClosed()) throw new Error('登录窗口未打开')
    switch (input.type) {
      case 'click': await this.page.mouse.click(input.x, input.y); break
      case 'text': await this.page.keyboard.insertText(input.text); break
      case 'key': await this.page.keyboard.press(input.key); break
      case 'wheel': await this.page.mouse.wheel(0, input.deltaY); break
    }
  }

  async withPage<T>(action: (page: Page) => Promise<T>): Promise<T> {
    await this.ensureBrowser()
    this.backgroundOperations++
    let page: Page | undefined
    try {
      page = await this.context!.newPage()
      return await action(page)
    } finally {
      await page?.close()
      this.backgroundOperations--
    }
  }

  async logout() {
    await Promise.allSettled([this.opening, this.navigating, this.confirming])
    if (!this.context) return
    try {
      await this.withPage(async page => {
        const response = await page.goto(this.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        if (!response) throw new Error('Circle.ms 退出前没有收到响应')
        if (response.status() === 401 || isLoginPage(page.url(), await page.content())) return
        if (!response.ok()) throw new Error(`Circle.ms 退出前检查失败（HTTP ${response.status()}）`)
        const link = page.locator(`a[href="/Account/LogOut"]`).filter({ hasText: 'ログアウト' }).first()
        await link.waitFor({ timeout: 10_000 })
        await link.click({ timeout: 30_000 })
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
        const url = new URL(page.url())
        if (url.origin === catalogOrigin && await page.locator('a[href="/Account/LogOut"]').count()) {
          throw new Error('Circle.ms 退出未完成，仍显示登录状态')
        }
      })
    } finally {
      this.authenticated = false
      this.visible = false
    }
  }

  async clear() {
    if (this.context) await this.context.clearCookies()
    await this.close()
    if (this.stateFile) await rm(this.stateFile, { force: true })
    this.authenticated = false
    this.visible = false
    this.lastError = null
  }

  async close() {
    const pending = await Promise.allSettled([this.opening, this.navigating, this.confirming])
    for (const result of pending) {
      if (result.status === 'rejected') console.warn('Browser operation failed during shutdown:', result.reason)
    }
    await this.browser?.close()
    this.browser = undefined
    this.context = undefined
    this.page = undefined
    this.authenticated = false
    this.visible = false
  }
}
