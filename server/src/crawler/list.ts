import { load } from 'cheerio'
import { CheerioCrawler } from 'crawlee'
import type { Configuration } from 'crawlee'
import { catalogOrigin, isLoginPage, LoginRequiredError } from './parser.js'
import type { LoginSession } from './login.js'

export const syllabaryUrl = `${catalogOrigin}/Circle/Syllabary`

function parameter(url: URL, name: string) {
  return [...url.searchParams].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

export function parseSyllabary(html: string, pageUrl: string) {
  if (isLoginPage(pageUrl, html)) throw new LoginRequiredError()
  const $ = load(html)
  const current = new URL(pageUrl)
  const days = new Map<number, string>()
  let selectedDay: number | undefined
  $('.date-list a[href]').each((_, node) => {
    const element = $(node)
    if (!/^\d+日目$/.test(element.text().trim())) return
    const url = new URL(element.attr('href')!, current)
    const value = parameter(url, 'day')
    if (url.origin !== current.origin || url.pathname !== '/Circle/Syllabary' || !/^[1-9]\d?$/.test(value ?? '')) {
      throw new Error('日期链接不是有效的五十音列表链接')
    }
    const day = Number(value)
    days.set(day, element.text().trim())
    if (/(?:^|\s)\S*_hover(?:\s|$)/.test(element.attr('class') ?? '')) {
      if (selectedDay !== undefined && selectedDay !== day) throw new Error('列表显示多个当前日期')
      selectedDay = day
    }
  })
  const requestedDay = parameter(current, 'day')
  if (!days.size || selectedDay === undefined || (requestedDay && Number(requestedDay) !== selectedDay)) {
    throw new Error('无法确认五十音列表的当前日期，或返回了错误日期')
  }
  const requestedColumn = parameter(current, 'column') ?? '0'
  if (!/^\d+$/.test(requestedColumn)) throw new Error('五十音行编号无效')
  const columns = new Map<number, string>()
  let selectedColumns = 0
  $('.sortnav-list > li').each((_, node) => {
    const element = $(node)
    const label = element.text().trim()
    if (!/^.+行$/.test(label)) throw new Error('五十音导航出现未知项目')
    const link = element.find('a[href]')
    let column = Number(requestedColumn)
    if (link.length) {
      const url = new URL(link.attr('href')!, current)
      const value = parameter(url, 'column')
      if (url.origin !== current.origin || url.pathname !== '/Circle/Syllabary' || !/^\d+$/.test(value ?? '')) {
        throw new Error('五十音行链接无效')
      }
      column = Number(value)
    } else {
      selectedColumns++
    }
    if (columns.has(column)) throw new Error('五十音行导航重复或当前行与请求不匹配')
    columns.set(column, label)
  })
  if (selectedColumns !== 1 || !columns.size || !$('.md-circlelist').length) {
    throw new Error('五十音列表结构不完整，无法确认已读取当前行')
  }
  const ids = new Set<string>()
  $('.md-circlelist a[href]').each((_, node) => {
    const url = new URL($(node).attr('href')!, current)
    const match = /^\/Circle\/(\d+)\/?$/.exec(url.pathname)
    if (url.origin === current.origin && match) ids.add(match[1]!)
  })
  return {
    days: [...days].sort(([a], [b]) => a - b),
    columns: [...columns].sort(([a], [b]) => a - b),
    day: selectedDay,
    column: Number(requestedColumn),
    ids: [...ids],
    eventId: html.match(/\beventId\s*:\s*(\d+)/)?.[1] ?? null,
  }
}

export async function collectList(options: {
  login: Pick<LoginSession, 'cookieHeader'>
  config: Configuration
  signal: AbortSignal
  progress: (ids: string[], eventId: string | null, action: string) => Promise<void>
  startUrl?: string
}) {
  const { login, config, signal, progress } = options
  const startUrl = options.startUrl ?? syllabaryUrl
  const ids = new Set<string>()
  const completed = new Set<string>()
  let expected: Set<string> | undefined
  let days: string | undefined
  let columns: string | undefined
  let eventId: string | null = null
  let failure: Error | undefined
  function pageUrl(day: number, column: number) {
    const url = new URL('/Circle/Syllabary', startUrl)
    // Row links in the source omit Day, so always carry the selected day explicitly.
    url.searchParams.set('Day', String(day))
    url.searchParams.set('column', String(column))
    return url.href
  }
  const crawler = new CheerioCrawler({
    maxConcurrency: 1,
    maxRequestsPerMinute: 60,
    maxRequestRetries: 2,
    useSessionPool: false,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    preNavigationHooks: [async ({ request }, requestOptions) => {
      signal.throwIfAborted()
      if (failure) { request.noRetry = true; throw failure }
      requestOptions.headers = { ...requestOptions.headers, cookie: await login.cookieHeader(request.url) }
      const url = new URL(request.url)
      await progress([...ids], eventId, `爬取五十音列表：第 ${parameter(url, 'day') ?? '默认'} 日，第 ${Number(parameter(url, 'column') ?? 0) + 1} 行，已发现 ${ids.size} 个社团`)
    }],
    errorHandler({ request, response }, error) {
      console.warn('Syllabary list request failed:', error.message)
      if (signal.aborted || error instanceof LoginRequiredError || [401, 403].includes(response?.statusCode ?? 0)) {
        request.noRetry = true
        if (!signal.aborted) failure = new LoginRequiredError()
      }
    },
    async requestHandler({ request, body, response }) {
      signal.throwIfAborted()
      if (failure) throw failure
      const page = parseSyllabary(String(body), response.url ?? request.loadedUrl ?? request.url)
      if (eventId && page.eventId && eventId !== page.eventId) throw new Error('列表活动 ID 在采集期间改变')
      eventId ??= page.eventId
      const pageDays = JSON.stringify(page.days)
      const pageColumns = JSON.stringify(page.columns)
      if (!expected) {
        days = pageDays
        columns = pageColumns
        const tasks = page.days.flatMap(([day]) => page.columns.map(([column]) => ({ day, column })))
        expected = new Set(tasks.map(task => `${task.day}:${task.column}`))
        await crawler.addRequests(tasks
          .filter(task => task.day !== page.day || task.column !== page.column)
          .map(task => ({ url: pageUrl(task.day, task.column) })))
      } else if (days !== pageDays || columns !== pageColumns) {
        throw new Error('日期或五十音行导航改变，无法确认列表完整')
      }
      const key = `${page.day}:${page.column}`
      if (!expected.has(key)) throw new Error('返回了未请求的日期或五十音行')
      for (const id of page.ids) ids.add(id)
      completed.add(key)
      await progress([...ids], eventId,
        `爬取列表：第 ${page.day} 日 ${page.columns.find(([column]) => column === page.column)![1]} 已读取；${completed.size}/${expected.size} 个日期/行页面完成，已发现 ${ids.size} 个社团`)
    },
    failedRequestHandler({ response }, error) {
      failure ??= [401, 403].includes(response?.statusCode ?? 0) ? new LoginRequiredError() : error
    },
  }, config)
  const abort = () => { void crawler.autoscaledPool?.abort().catch(error => console.error('List abort failed:', error)) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await crawler.run([startUrl])
    signal.throwIfAborted()
    if (failure) throw failure
    if (!expected || completed.size !== expected.size || !ids.size) {
      throw new Error('尚未成功读取全部日期和五十音行，不能开始详情采集')
    }
    return { ids: [...ids], eventId }
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
