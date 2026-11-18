import { AsyncLocalStorage } from 'node:async_hooks'
import { Rettiwt } from 'rettiwt-api'
import { Dispatcher, getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import { imageExtension } from '../../crawler/images.js'
import { validPixivId } from '../pixiv/source.js'

export interface TwitterImage { id: string; url: string; tweetId: string; publishedAt: Date; mediaIndex: number }
export interface TwitterSource {
  resolve(username: string, signal: AbortSignal): Promise<string>
  latest(id: string, signal: AbortSignal): Promise<TwitterImage[]>
  download(url: string, signal: AbortSignal): Promise<{ body: Buffer; extension: string }>
  close?(): Promise<void>
}
export class TwitterAccessError extends Error {}
interface TwitterMediaTweet {
  id: string
  createdAt: string
  tweetBy: { id: string }
  retweetedTweet?: unknown
  raw: { legacy?: { extended_entities?: { media: { id_str: string; media_url_https: string }[] } } }
}
export interface TwitterClient {
  details(username: string): Promise<{ id: string } | undefined>
  media(id: string, count: number, cursor?: string): Promise<{ list: TwitterMediaTweet[]; next: string }>
}

function compareImages(a: TwitterImage, b: TwitterImage): number {
  return b.publishedAt.getTime() - a.publishedAt.getTime()
    || (a.tweetId === b.tweetId ? a.mediaIndex - b.mediaIndex : BigInt(a.tweetId) > BigInt(b.tweetId) ? -1 : 1)
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

export function normalizeTwitterApiKey(apiKey: string): string {
  // Rettiwt's cookie parser treats whitespace after ";" as part of the cookie name.
  const cookies = Buffer.from(apiKey, 'base64').toString('ascii').split(';').map(cookie => cookie.trim()).filter(Boolean)
  return Buffer.from(`${cookies.join(';')};`, 'ascii').toString('base64')
}

const requestProxy = new AsyncLocalStorage<ProxyAgent>()
let scopedDispatcher: Dispatcher | undefined
function withProxy<T>(proxy: ProxyAgent | undefined, request: () => Promise<T>): Promise<T> {
  if (!proxy) return request()
  if (getGlobalDispatcher() !== scopedDispatcher) {
    const fallback = getGlobalDispatcher()
    // Rettiwt's transaction dependency uses native fetch, outside its configured HTTP client.
    scopedDispatcher = new class extends Dispatcher {
      dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
        return (requestProxy.getStore() ?? fallback).dispatch(options, handler)
      }
    }()
    setGlobalDispatcher(scopedDispatcher)
  }
  return requestProxy.run(proxy, request)
}

export class RettiwtSource implements TwitterSource {
  private readonly proxy: ProxyAgent | undefined
  private readonly client: TwitterClient | undefined
  private readonly request: typeof fetch
  constructor(
    options: { apiKey?: string | undefined; proxyUrl?: string | undefined } = {},
    client?: TwitterClient,
    request: typeof fetch = fetch,
  ) {
    this.request = request
    let proxyUrl: URL | undefined
    if (options.proxyUrl) {
      proxyUrl = new URL(options.proxyUrl)
      if (!['http:', 'https:'].includes(proxyUrl.protocol)) throw new Error('TWITTER_PROXY_URL 必须使用 HTTP/HTTPS')
      this.proxy = new ProxyAgent(proxyUrl.href)
    }
    this.client = client ?? (options.apiKey ? new Rettiwt({
      apiKey: normalizeTwitterApiKey(options.apiKey), timeout: 60_000, logging: false, proxy: proxyUrl?.href ?? null,
      // Preserve diagnostics internally; api() only exposes allowlisted error information.
      errorHandler: { handle(error: unknown) { throw error } },
    }).user : undefined)
  }
  private async api<T>(signal: AbortSignal, call: (client: TwitterClient) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (!this.client) throw new TwitterAccessError('Twitter 采集需要配置 TWITTER_API_KEY（Rettiwt 用户认证密钥）')
    try {
      const client = this.client
      const result = await withProxy(this.proxy, () => call(client))
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      const details = errorRecord(error)
      const response = errorRecord(details?.response)
      const status = Number(response?.status ?? details?.status)
      if (status === 401) throw new TwitterAccessError('Twitter 认证被拒绝（HTTP 401），请检查 TWITTER_API_KEY 的 Cookie 格式、登录会话及 Rettiwt 接口兼容性')
      if (status === 403) throw new TwitterAccessError('Twitter 访问被拒绝（HTTP 403），请检查账号权限和访问限制')
      if (status === 429) throw new TwitterAccessError('Twitter 请求受到限流（HTTP 429），请稍后重试')
      const code = details?.code ?? errorRecord(details?.cause)?.code
      if (typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
        throw new Error(`Twitter 网络请求失败（${code}），请检查 TWITTER_PROXY_URL；不会继承 Windows 系统代理或 PIXIV_PROXY_URL`)
      }
      if (typeof details?.code === 'string' && ['CLIENT_TRANSACTION_INITIALIZATION_ERROR', 'ONDEMAND_FILE_URL_RESOLUTION_ERROR',
        'KEY_BYTE_INDICES_EXTRACTION_ERROR', 'SITE_VERIFICATION_KEY_NOT_FOUND_ERROR', 'ANIMATION_FRAME_DATA_ERROR'].includes(details.code)) {
        throw new TwitterAccessError('Twitter 请求标识初始化失败，请检查网络及 Rettiwt 与当前 X 接口的兼容性')
      }
      // Rettiwt errors can contain request headers; never propagate their raw object to logs.
      throw new Error(`Twitter API 请求失败${Number.isInteger(status) && status >= 100 && status <= 599 ? `（HTTP ${status}）` : ''}，请检查网络、账号可见性及 Rettiwt 接口兼容性`)
    }
  }
  async resolve(username: string, signal: AbortSignal) {
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(username)) throw new Error('Twitter 用户名无效')
    const user = await this.api(signal, client => client.details(username))
    if (!user || !validPixivId(user.id)) throw new Error('Twitter 用户不存在或未返回数字 ID')
    return user.id
  }
  async latest(id: string, signal: AbortSignal) {
    if (!validPixivId(id)) throw new Error('Twitter 数字 ID 无效')
    const images = new Map<string, TwitterImage>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const cutoff = [...images.values()].sort(compareImages)[9]
      const result = await this.api(signal, client => client.media(id, 20, cursor))
      if (!Array.isArray(result.list)) throw new Error('Twitter 媒体列表格式无效')
      let beyondCutoff = !!cutoff && result.list.length > 0
      for (const tweet of result.list) {
        const publishedAt = new Date(tweet.createdAt)
        if (!validPixivId(tweet.id) || !Number.isFinite(publishedAt.getTime())) throw new Error('Twitter 推文发布时间或 ID 无效')
        if (cutoff && (publishedAt > cutoff.publishedAt || (publishedAt.getTime() === cutoff.publishedAt.getTime() && BigInt(tweet.id) > BigInt(cutoff.tweetId)))) {
          beyondCutoff = false
        }
        if (tweet.tweetBy.id !== id || tweet.retweetedTweet) continue
        const legacy = tweet.raw?.legacy
        if (!legacy) throw new Error('Twitter 媒体条目格式无效')
        if (legacy.extended_entities === undefined) continue
        const media = legacy.extended_entities.media
        if (!Array.isArray(media)) throw new Error('Twitter 媒体条目格式无效')
        for (const [mediaIndex, item] of media.entries()) {
          if (!validPixivId(item.id_str)) throw new Error('Twitter 媒体 ID 无效')
          const url = this.thumbnail(item.media_url_https)
          const image = { id: item.id_str, url: url.href, tweetId: tweet.id, publishedAt, mediaIndex }
          const previous = images.get(item.id_str)
          if (!previous || compareImages(image, previous) < 0) images.set(item.id_str, image)
        }
      }
      if (result.list.length && cursors.has(result.next)) throw new Error('Twitter 媒体分页无进展')
      // Confirm the time boundary on a following page; an old pinned post alone is not sufficient.
      // X can keep returning changing cursors on empty pages after the media stream ends.
      if (!result.list.length || !result.next || beyondCutoff) return [...images.values()].sort(compareImages).slice(0, 10)
      cursors.add(result.next); cursor = result.next
    }
    throw new Error('Twitter 媒体分页超过安全上限')
  }
  private thumbnail(value: string) {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || url.username || url.password || url.port) {
      throw new Error('Twitter 图片 URL 不受支持')
    }
    const match = /\.(jpg|jpeg|png|webp)(?::thumb)?$/i.exec(url.pathname)
    if (match) {
      if (/^\/(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//.test(url.pathname)) {
        // Video covers can reject format/name queries or ignore name and return the full cover.
        url.pathname = `${url.pathname.slice(0, -match[0].length)}.${match[1]!.toLowerCase()}:thumb`
        url.searchParams.delete('format')
        url.searchParams.delete('name')
        return url
      }
      url.pathname = url.pathname.slice(0, -match[0].length)
      url.searchParams.set('format', match[1]!.toLowerCase())
    }
    url.searchParams.set('name', 'thumb')
    return url
  }
  async download(value: string, signal: AbortSignal) {
    const url = this.thumbnail(value)
    const options = {
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: 'manual' as const,
      ...(this.proxy ? { dispatcher: this.proxy } : {}),
    }
    const response = await this.request(url, options)
    if (!response.ok) {
      await response.body?.cancel()
      if ([401, 403, 429].includes(response.status)) throw new TwitterAccessError(`Twitter 图片请求失败（HTTP ${response.status}）`)
      throw new Error(`Twitter 图片请求失败（HTTP ${response.status}）`)
    }
    if (!response.body) throw new Error('Twitter 图片响应为空')
    const limit = 20 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body.cancel(); throw new Error('Twitter 图片超过 20 MiB')
    }
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) throw new Error('Twitter 图片超过 20 MiB')
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    return { body, extension: imageExtension(body) }
  }
  async close() { await this.proxy?.close() }
}
