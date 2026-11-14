import { load } from 'cheerio'
import type { Booth } from '../db/schema.js'

export const catalogOrigin = 'https://classic-webcatalog.circle.ms'
export const listUrl = `${catalogOrigin}/Spa`

export class LoginRequiredError extends Error {
  constructor() {
    super('Web Catalog 登录已失效，请在登录窗口重新登录')
  }
}

export function isLoginPage(url: string, html: string): boolean {
  return /\/account\/(?:login|signin)|auth2?\.circle\.ms/i.test(url)
    || /<input\b[^>]*type=["']password["']/i.test(html)
}

export function parseLocation(value: string) {
  const normalized = value.normalize('NFKC').replace(/\s+/g, '')
  const match = /^([月火水木金土日])曜日([東西南北])(.+?)(\d{2})(ab|a|b)?$/i.exec(normalized)
  if (!match) throw new Error(`无法识别配置スペース：${value}`)
  return {
    weekday: match[1]!,
    hall: match[2]!,
    island_code: match[3]!,
    booth_number: match[4]!,
    booth_suffix: match[5]?.toLowerCase() ?? null,
  }
}

export function parseDetail(html: string, expectedId: string) {
  const sourceUrl = `${catalogOrigin}/Circle/${expectedId}`
  if (isLoginPage(sourceUrl, html)) throw new LoginRequiredError()
  const $ = load(html)
  const id = $('#mainSection .webcatalog-circle-list-detail').attr('id')
  if (id !== expectedId) throw new Error(`详情 ID 不匹配：期望 ${expectedId}，实际 ${id ?? '缺失'}`)

  function cell(label: string) {
    const th = $('.md-itemtable th').filter((_, node) => $(node).text().trim() === label).first()
    if (!th.length) throw new Error(`详情缺少字段：${label}`)
    return th.next('td')
  }
  function text(label: string) {
    const element = cell(label).clone()
    element.find('a[href*="google."], script, style').remove()
    return element.text().replace(/\s+/g, ' ').trim()
  }
  const circleName = text('サークル名')
  const circleLink = cell('サークル名').find('a[href*="/Circle/Index/"]').attr('href')
  const circleId = circleLink?.match(/\/Circle\/Index\/(\d+)/)?.[1]
  const eventId = html.match(/\beventId\s*:\s*(\d+)/)?.[1]
  const editions = new Set<string>()
  function addHashtags(value: string | null | undefined) {
    for (const match of value?.matchAll(/\bC(\d+)WebCatalog\b/gi) ?? []) editions.add(match[1]!)
  }
  $('[data-hashtags]').each((_, node) => { addHashtags($(node).attr('data-hashtags')) })
  $('iframe[src], a[href]').each((_, node) => {
    const value = $(node).attr('src') ?? $(node).attr('href') ?? ''
    const params = new URL(value, catalogOrigin).searchParams
    for (const hash of [params.get('hashtags'), new URLSearchParams(new URL(value, catalogOrigin).hash.slice(1)).get('hashtags')]) {
      addHashtags(hash)
    }
  })
  if (!circleName || !eventId || editions.size !== 1) {
    throw new Error('详情缺少社团名、活动 ID 或唯一的 CxxxWebCatalog hashtag')
  }
  const comiket = Number([...editions][0])
  if (!Number.isSafeInteger(comiket) || comiket < 1) throw new Error('无效的 Comiket 届数')
  const rawGenre = text('ジャンル')
  const genreMatch = /^(.*?)\s*\((\d+)\)\s*$/.exec(rawGenre)
  if (rawGenre && !genreMatch) throw new Error(`无法识别ジャンル：${rawGenre}`)
  const socialLinks = cell('サークル情報登録状況').find('a[href]').map((_, node) => $(node).attr('href')!).get()
  let pixivId: string | null = null
  let twitterId: string | null = null
  for (const value of socialLinks) {
    const url = new URL(value, catalogOrigin)
    if (/^(?:www\.)?pixiv\.net$/.test(url.hostname)) {
      const candidate = url.pathname.match(/^\/users\/(\d+)\/?$/)?.[1] ?? url.searchParams.get('id')
      if (candidate && /^\d+$/.test(candidate)) pixivId = candidate
    }
    if (/^(?:www\.)?(?:twitter\.com|x\.com)$/.test(url.hostname)) {
      twitterId = url.pathname.match(/^\/([A-Za-z0-9_]{1,64})\/?$/)?.[1] ?? null
    }
  }
  const images = new Map<string, { url: string; stem: string }>()
  $('.m-circletable-cuts img[src]').each((_, node) => {
    const url = new URL($(node).attr('src')!, catalogOrigin)
    if (url.origin === catalogOrigin && /^\/Spa\/CachedImage\/\d+\/2\//.test(url.pathname)
      && !images.has(url.href)) {
      const stem = `${expectedId}_${images.size + 1}`
      images.set(url.href, { url: url.href, stem })
    }
  })
  const booth: Booth = {
    id: expectedId,
    event_id: eventId,
    comiket,
    circle_name: circleName,
    author_name: text('執筆者名') || null,
    ...parseLocation(text('配置スペース')),
    genre: genreMatch?.[1]?.trim() || null,
    genre_code: genreMatch?.[2] ?? null,
    circle_id: circleId ?? null,
    pixiv_id: pixivId,
    twitter_id: twitterId,
    images: '[]',
    source_url: sourceUrl,
    last_crawled_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
  return { booth, images: [...images.values()] }
}
