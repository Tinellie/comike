import { load } from 'cheerio'
import { catalogOrigin, isLoginPage, LoginRequiredError } from '../crawler/parser.js'

export interface Favorite { boothId: string; colour: string; memo: string }
export const favoritesUrl = `${catalogOrigin}/User/Favorites?count=100&page=1`

export function normalizeColour(value: string): string {
  const hex = /^#([\da-f]{6}|[\da-f]{3})$/i.exec(value.trim())
  if (hex) {
    const digits = hex[1]!
    return `#${digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits}`.toUpperCase()
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value.trim())
  if (rgb && rgb.slice(1).every(part => Number(part) <= 255)) {
    return `#${rgb.slice(1).map(part => Number(part).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  }
  throw new Error('收藏标记颜色无效或无法确认')
}

export function parseFavorites(html: string, pageNumber: number) {
  if (isLoginPage(favoritesUrl, html)) throw new LoginRequiredError()
  const $ = load(html)
  // Saved browser fixtures may contain multiple document snapshots.
  const table = $('table.t-user-favorites').first()
  if (!table.length) throw new Error('收藏列表结构缺失，不能确认完整导入')
  const pagination = $('.m-pagination').first()
  const label = pagination.find('.m-pagination-label').text().trim()
  const range = /^(\d+)\s*件中\s*(\d+)\s*件目\s*[-–]\s*(\d+)\s*件目$/.exec(label)
  const empty = /^0\s*件中(?:\s|$)/.test(label)
  if (!range && !empty) throw new Error('无法确认收藏总数及当前页范围')
  const total = range ? Number(range[1]) : 0
  const pages = Math.max(1, Math.ceil(total / 100))
  if (!Number.isSafeInteger(total) || total > 100_000 || pageNumber < 1 || pageNumber > pages) {
    throw new Error('收藏分页数量或页号无效')
  }
  const navigationPages = new Set<number>([pageNumber])
  pagination.find('a[href]').each((_, node) => {
    const url = new URL($(node).attr('href')!, catalogOrigin)
    if (url.origin !== catalogOrigin || url.pathname !== '/User/Favorites'
      || url.searchParams.get('count') !== '100' || !/^[1-9]\d*$/.test(url.searchParams.get('page') ?? '')) {
      throw new Error('收藏翻页链接无效')
    }
    navigationPages.add(Number(url.searchParams.get('page')))
  })
  if (Math.max(...navigationPages) !== pages || [...navigationPages].some(page => page > pages)) {
    throw new Error('收藏翻页按钮与总数不一致')
  }
  if (range && ((total > 0 && (Number(range[2]) !== (pageNumber - 1) * 100 + 1
    || Number(range[3]) !== Math.min(pageNumber * 100, total)))
    || (total === 0 && (![0, 1].includes(Number(range[2])) || Number(range[3]) !== 0)))) {
    throw new Error('收藏返回了错误页，或列表在导入期间发生变化')
  }
  const css = $('style').map((_, node) => $(node).text()).get().join('\n')
  const colours = new Map<string, string>()
  for (const match of css.matchAll(/td\.favorite-color-(\d+)\s*\{\s*background(?:-color)?\s*:\s*(#[\da-f]{3,6})\s*;?\s*\}/gi)) {
    colours.set(match[1]!, normalizeColour(match[2]!))
  }
  const entries: Favorite[] = []
  const ids = new Set<string>()
  table.find('tr.webcatalog-circle-list-detail').each((_, node) => {
    const row = $(node)
    const links = row.find('.infotable-circlename a[href]')
    if (links.length !== 1) throw new Error('收藏条目缺少唯一的社团链接')
    const url = new URL(links.attr('href')!, catalogOrigin)
    const id = /^\/Circle\/(\d{1,32})\/?$/.exec(url.pathname)?.[1]
    if (url.origin !== catalogOrigin || !id || ids.has(id)) throw new Error('收藏社团 ID 无效或重复')
    const cell = row.children('td.favorite-color')
    const colourClass = /\bfavorite-color-(\d+)\b/.exec(cell.attr('class') ?? '')?.[1]
    const inline = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(cell.attr('style') ?? '')?.[1]
    const colourValue = cell.attr('data-import-colour') ?? inline ?? (colourClass && colours.get(colourClass))
    if (cell.length !== 1 || !colourValue) throw new Error('收藏条目缺少标记颜色')
    const memoCell = row.next('tr').find('span[data-bind*="text: favMemo"]')
    if (memoCell.length !== 1) throw new Error('收藏条目缺少备注字段')
    const memo = memoCell.clone()
    memo.find('br').replaceWith('\n')
    memo.find('script, style').remove()
    const text = memo.text().replace(/\r\n?/g, '\n')
    if (text.length > 2048) throw new Error('收藏备注超过 2048 字符')
    entries.push({ boothId: id, colour: normalizeColour(colourValue), memo: text })
    ids.add(id)
  })
  if (entries.length !== Math.max(0, Math.min(100, total - (pageNumber - 1) * 100))) {
    throw new Error('收藏条目数量与分页范围不一致，可能尚未加载完成')
  }
  return { entries, total, pages }
}
