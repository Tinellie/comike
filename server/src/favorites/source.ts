import type { RemoteLogin } from '../crawler/login.js'
import { catalogOrigin, isLoginPage, LoginRequiredError } from '../crawler/parser.js'
import { favoritesUrl, parseFavorites } from './parser.js'
import type { Favorite } from './parser.js'

export async function collectFavorites(
  login: Pick<RemoteLogin, 'withPage'>, signal: AbortSignal,
  progress: (page: number, pages: number, count: number) => void,
): Promise<Favorite[]> {
  return login.withPage(async page => {
    const abort = () => { void page.close().catch(error => console.warn('Import page abort failed:', error)) }
    signal.addEventListener('abort', abort, { once: true })
    const entries = new Map<string, Favorite>()
    let expectedTotal: number | undefined
    let pages = 1
    try {
      for (let number = 1; number <= pages; number++) {
        signal.throwIfAborted()
        const url = new URL(favoritesUrl)
        url.searchParams.set('page', String(number))
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        if (!response) throw new Error('收藏页面没有返回响应')
        if ([401, 403].includes(response.status()) || isLoginPage(page.url(), await page.content())) throw new LoginRequiredError()
        if (!response.ok()) throw new Error(`读取收藏失败（HTTP ${response.status()}）`)
        const actual = new URL(page.url())
        if (actual.origin !== catalogOrigin || actual.pathname !== '/User/Favorites'
          || actual.searchParams.get('page') !== String(number) || actual.searchParams.get('count') !== '100') {
          throw new Error('收藏页面发生了非预期跳转')
        }
        await page.waitForFunction(() => {
          const label = document.querySelector('.m-pagination-label')?.textContent ?? ''
          const table = document.querySelector('table.t-user-favorites')
          if (!table) return false
          const total = Number(/(\d+)\s*件中/.exec(label)?.[1] ?? -1)
          const count = table.querySelectorAll('tr.webcatalog-circle-list-detail .infotable-circlename a[href^="/Circle/"]').length
          return total === 0 || count > 0
        }, undefined, { timeout: 20_000 })
        await page.locator('table.t-user-favorites').first().locator('td.favorite-color').evaluateAll(cells => {
          for (const cell of cells) cell.setAttribute('data-import-colour', getComputedStyle(cell).backgroundColor)
        })
        const result = parseFavorites(await page.content(), number)
        if (expectedTotal !== undefined && (expectedTotal !== result.total || pages !== result.pages)) {
          throw new Error('收藏列表在导入期间发生变化，请重新导入')
        }
        expectedTotal = result.total
        pages = result.pages
        for (const entry of result.entries) {
          if (entries.has(entry.boothId)) throw new Error('分页间存在重复社团，请重新导入以保证完整性')
          entries.set(entry.boothId, entry)
        }
        progress(number, pages, entries.size)
      }
      signal.throwIfAborted()
      if (entries.size !== expectedTotal) throw new Error('收藏总数不完整')
      return [...entries.values()]
    } finally {
      signal.removeEventListener('abort', abort)
    }
  })
}
