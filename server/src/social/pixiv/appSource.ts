import { ProxyAgent } from 'undici'
import timers from 'node:timers/promises'
import { imageExtension } from '../../crawler/images.js'
import { PIXIV_IMAGE_LIMIT, PixivAccessError, newestFirst, validPixivId } from './source.js'
import type { PixivSource } from './source.js'

const apiOrigin = 'https://app-api.pixiv.net'
const oauthUrl = 'https://oauth.secure.pixiv.net/auth/token'
const downloadImageLimit = 20 * 1024 * 1024
export interface PixivAppOptions {
  accessToken?: string | undefined
  refreshToken?: string | undefined
  clientId?: string | undefined
  clientSecret?: string | undefined
  proxyUrl?: string | undefined
}
export function pixivAppOptions(environment = process.env): PixivAppOptions {
  return {
    accessToken: environment.PIXIV_ACCESS_TOKEN,
    refreshToken: environment.PIXIV_REFRESH_TOKEN,
    clientId: environment.PIXIV_CLIENT_ID,
    clientSecret: environment.PIXIV_CLIENT_SECRET,
    proxyUrl: environment.PIXIV_PROXY_URL,
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown) {
  if (typeof value === 'string' && validPixivId(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  throw new Error('Pixiv App API 返回了无效 ID')
}

export class PixivAppSource implements PixivSource {
  private readonly options: PixivAppOptions
  private readonly request: typeof fetch
  private readonly proxy: ProxyAgent | undefined
  private accessToken: string
  private refreshToken: string
  private expiresAt = Infinity
  private refreshing: Promise<void> | null = null
  private recovering: Promise<Response> | null = null
  private retry: { attempts: number; retryAt: number | null } | null = null

  warning() { return this.recovering ? 'Pixiv 请求受到限流（HTTP 429），已暂停请求，每隔 1 分钟自动重试' : null }
  retryStatus() { return this.retry ? { ...this.retry } : null }

  constructor(options: PixivAppOptions = {}, request: typeof fetch = fetch) {
    this.options = options
    this.accessToken = options.accessToken ?? ''
    this.refreshToken = options.refreshToken ?? ''
    if (options.proxyUrl) {
      let url: URL
      try { url = new URL(options.proxyUrl) } catch { throw new Error('PIXIV_PROXY_URL 必须是有效的 HTTP / HTTPS 代理地址') }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PIXIV_PROXY_URL 仅支持 HTTP / HTTPS 代理')
      this.proxy = new ProxyAgent(options.proxyUrl)
    }
    this.request = (input, init) => {
      const requestOptions = { ...init, ...(this.proxy ? { dispatcher: this.proxy } : {}) }
      return request(input, requestOptions)
    }
  }

  async close() { await this.proxy?.close() }

  private async send(url: string | URL, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    const request = () => {
      signal.throwIfAborted()
      return this.request(url, {
        ...init, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      })
    }
    if (this.recovering) await this.recovering
    let response = await request()
    if (response.status !== 429) return response
    await response.body?.cancel()
    if (this.recovering) {
      await this.recovering
      return this.send(url, signal, init)
    }
    const retry: { attempts: number; retryAt: number | null } = { attempts: 0, retryAt: null }
    this.retry = retry
    this.recovering = (async () => {
      do {
        retry.retryAt = Date.now() + 60_000
        console.warn(`Pixiv 请求受到限流（HTTP 429），已重试 ${retry.attempts} 次，等待 1 分钟后进行第 ${retry.attempts + 1} 次重试`)
        await timers.setTimeout(60_000, undefined, { signal })
        signal.throwIfAborted()
        retry.attempts++
        retry.retryAt = null
        response = await request()
        if (response.status === 429) await response.body?.cancel()
      } while (response.status === 429)
      return response
    })()
    try { return await this.recovering } finally { this.recovering = null; this.retry = null }
  }

  private async checkResponse(response: Response) {
    let message: string | undefined
    if (response.headers.get('cf-mitigated') === 'challenge') {
      message = 'Pixiv 请求被 Cloudflare 人机验证拦截，已停止整个任务，请检查网络访问状态，勿连续重试'
    } else if (response.status === 401) {
      message = 'Pixiv OAuth 认证失效（HTTP 401），请更新 Token 或检查自动刷新配置'
    } else if (response.status === 403) {
      message = 'Pixiv App API 访问被拒绝（HTTP 403），请检查账号权限、内容设置及访问限制'
    } else if (response.status >= 300 && response.status < 400) {
      message = 'Pixiv 请求被重定向，已停止整个任务，请检查认证及访问限制'
    }
    if (message) {
      await response.body?.cancel()
      throw new PixivAccessError(message)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Pixiv 请求失败：HTTP ${response.status}`)
    }
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    let result: unknown
    try { result = await response.json() } catch {
      throw new PixivAccessError('Pixiv 未返回有效 JSON，请检查认证、访问限制或接口变化')
    }
    if (!object(result)) throw new Error('Pixiv App API 响应格式无效')
    return result
  }

  private canRefresh() {
    return !!(this.refreshToken && this.options.clientId && this.options.clientSecret)
  }

  private async refresh(signal: AbortSignal) {
    if (!this.canRefresh()) {
      throw new PixivAccessError('Pixiv 采集需要 PIXIV_ACCESS_TOKEN，或 PIXIV_REFRESH_TOKEN 及对应的 PIXIV_CLIENT_ID / PIXIV_CLIENT_SECRET')
    }
    if (this.refreshing) return this.refreshing
    this.refreshing = this.exchange(signal)
    try { await this.refreshing } finally { this.refreshing = null }
  }

  private async exchange(signal: AbortSignal) {
    const response = await this.send(oauthUrl, signal, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: this.refreshToken,
        client_id: this.options.clientId!, client_secret: this.options.clientSecret!,
      }).toString(),
    })
    if (response.status === 400) {
      await response.body?.cancel()
      throw new PixivAccessError('Pixiv OAuth 刷新失败：请检查 refresh token 及对应客户端凭据，或重新授权')
    }
    await this.checkResponse(response)
    const result = await this.json(response)
    const token = object(result.response) ? result.response : result
    if (typeof token.access_token !== 'string' || !token.access_token || /[^\x21-\x7e]/.test(token.access_token)
      || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0
      || ('refresh_token' in token && (typeof token.refresh_token !== 'string' || !token.refresh_token))) {
      throw new PixivAccessError('Pixiv OAuth 响应缺少有效 Token 或有效期，已停止任务')
    }
    this.accessToken = token.access_token
    if (typeof token.refresh_token === 'string') this.refreshToken = token.refresh_token
    this.expiresAt = Date.now() + Math.max(0, token.expires_in * 1000 - 30_000)
  }

  private async api(url: URL, signal: AbortSignal) {
    if (!this.accessToken || Date.now() >= this.expiresAt) await this.refresh(signal)
    if (/[^\x21-\x7e]/.test(this.accessToken)) throw new PixivAccessError('PIXIV_ACCESS_TOKEN 格式无效')
    const token = this.accessToken
    const send = (accessToken: string) => this.send(url, signal, { headers: {
      Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Accept-Language': 'ja',
    } })
    let response = await send(token)
    if (response.status === 401 && this.canRefresh()) {
      await response.body?.cancel()
      if (this.refreshing) await this.refreshing
      else if (this.accessToken === token) await this.refresh(signal)
      response = await send(this.accessToken)
    }
    await this.checkResponse(response)
    const result = await this.json(response)
    if (result.error) {
      if (object(result.error) && (result.error.reason === 'invalid_grant' || result.error.reason === 'invalid_token')) {
        throw new PixivAccessError('Pixiv OAuth Token 无效，请重新授权或更新 Token')
      }
      throw new Error('Pixiv App API 返回错误，请检查作品可见性、账号设置及接口权限')
    }
    return result
  }

  private async works(pixivId: string, type: 'illust' | 'manga', signal: AbortSignal) {
    let url: URL | null = new URL('/v1/user/illusts', apiOrigin)
    url.search = new URLSearchParams({ user_id: pixivId, type, filter: '' }).toString()
    const seen = new Set<string>()
    const ids: string[] = []
    while (url && ids.length < PIXIV_IMAGE_LIMIT) {
      if (seen.has(url.href) || seen.size >= 100) throw new Error('Pixiv App API 分页无进展，未修改图片缓存')
      seen.add(url.href)
      const result = await this.api(url, signal)
      if (!Array.isArray(result.illusts)) throw new Error('Pixiv App API 作品列表格式无效')
      for (const work of result.illusts) {
        if (!object(work) || !object(work.user) || id(work.user.id) !== pixivId) throw new Error('Pixiv 作品作者不匹配')
        if (work.is_visible === false) throw new Error('Pixiv 返回了不可见作品，请检查账号内容设置；未跳过或替换缓存')
        ids.push(id(work.id))
      }
      if (result.next_url === null) break
      if (typeof result.next_url !== 'string') throw new Error('Pixiv App API 分页数据无效')
      const next = new URL(result.next_url)
      if (next.origin !== apiOrigin || next.username || next.password || next.pathname !== '/v1/user/illusts'
        || next.searchParams.get('user_id') !== pixivId || next.searchParams.get('type') !== type
        || (next.searchParams.get('filter') ?? '') !== '') throw new Error('Pixiv App API 分页 URL 无效')
      url = next
    }
    return ids
  }

  async latest(pixivId: string, signal: AbortSignal) {
    if (!validPixivId(pixivId)) throw new Error('Pixiv 用户 ID 无效')
    const illustrations = await this.works(pixivId, 'illust', signal)
    const manga = await this.works(pixivId, 'manga', signal)
    return newestFirst([...illustrations, ...manga]).slice(0, PIXIV_IMAGE_LIMIT)
  }

  async image(pixivId: string, imageId: string, signal: AbortSignal) {
    if (!validPixivId(pixivId) || !validPixivId(imageId)) throw new Error('Pixiv 图片 ID 无效')
    const url = new URL('/v1/illust/detail', apiOrigin)
    url.searchParams.set('illust_id', imageId)
    const result = await this.api(url, signal), work = result.illust
    if (!object(work) || id(work.id) !== imageId || !object(work.user) || id(work.user.id) !== pixivId) throw new Error('Pixiv 作品 ID 或作者不匹配')
    if (work.is_visible === false) throw new Error('Pixiv 作品不可见，请检查账号内容设置')
    const thumbnail = object(work.image_urls) ? work.image_urls.square_medium : undefined
    if (typeof thumbnail !== 'string') throw new Error('Pixiv 作品没有可用的 square_medium 缩略图，不回退到其他尺寸')
    const imageUrl = new URL(thumbnail)
    if (imageUrl.protocol !== 'https:' || !imageUrl.hostname.endsWith('.pximg.net') || imageUrl.port || imageUrl.username || imageUrl.password) {
      throw new Error('Pixiv 图片 URL 不受支持')
    }
    const response = await this.send(imageUrl, signal, { headers: { Referer: 'https://www.pixiv.net/' } })
    await this.checkResponse(response)
    if (!response.body) throw new Error('Pixiv 图片响应体为空')
    if (Number(response.headers.get('content-length')) > downloadImageLimit) {
      await response.body.cancel()
      throw new Error('Pixiv 缩略图超过 20 MiB 下载安全上限')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > downloadImageLimit) throw new Error('Pixiv 缩略图超过 20 MiB 下载安全上限')
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    return { body, extension: imageExtension(body) }
  }
}
