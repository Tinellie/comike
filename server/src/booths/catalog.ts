import { readFile, stat } from 'node:fs/promises'

export interface HallGroup {
  name: string
  direction: string
  islands: string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseHallGroups(value: unknown): HallGroup[] {
  if (!record(value) || !Array.isArray(value.halls) || !value.halls.length) throw new Error('地图缺少 Hall 数据')
  const used = new Set<string>()
  return value.halls.map((hall: unknown) => {
    if (!record(hall) || typeof hall.name !== 'string' || !/^[東西南北]\d+$/.test(hall.name)
      || !Array.isArray(hall.islands)) throw new Error('地图 Hall 名称或 island 列表无效')
    const direction = hall.name[0]!
    const islands: string[] = []
    for (const island of hall.islands) {
      if (!record(island) || !(island.code === null || typeof island.code === 'string')) {
        throw new Error('地图 island code 无效')
      }
      if (island.code === null) continue
      const code = island.code.normalize('NFKC')
      const key = `${direction}:${code}`
      if (!code || used.has(key)) throw new Error('地图中同一方向的 island code 缺失或重复')
      used.add(key)
      islands.push(code)
    }
    return { name: hall.name, direction, islands }
  })
}

export function createHallGroupsLoader(file: string) {
  let cached: { modified: number; groups: HallGroup[] } | undefined
  return async () => {
    const info = await stat(file)
    if (cached?.modified === info.mtimeMs) return cached.groups
    const groups = parseHallGroups(JSON.parse(await readFile(file, 'utf8')))
    cached = { modified: info.mtimeMs, groups }
    return groups
  }
}

export function hallGroup(groups: HallGroup[], direction: string, island: string) {
  return groups.find(group => group.direction === direction && group.islands.includes(island.normalize('NFKC')))?.name
    ?? `${direction}（未匹配）`
}

const weekdays = ['月', '火', '水', '木', '金', '土', '日']
const numerals = ['一', '二', '三', '四', '五', '六', '七']

export function eventDays(values: string[]) {
  const sorted = [...new Set(values)].map(value => {
    const index = weekdays.indexOf(value)
    if (index < 0) throw new Error(`无效的曜日：${value}`)
    return index
  }).sort((a, b) => a - b)
  if (!sorted.length) return { days: [], warning: null }
  const gaps = sorted.map((day, index) => ((sorted[(index + 1) % sorted.length]! - day + 7) % 7) || 7)
  const largest = Math.max(...gaps)
  const ambiguous = sorted.length > 1 && gaps.filter(gap => gap === largest).length > 1
  const start = ambiguous ? 0 : (gaps.indexOf(largest) + 1) % sorted.length
  const ordered = [...sorted.slice(start), ...sorted.slice(0, start)]
  return {
    days: ordered.map((day, index) => ({ weekday: weekdays[day]!, order: index + 1, label: `${numerals[index]}日目` })),
    warning: ambiguous ? '仅凭曜日无法唯一推断日期顺序，当前按周一至周日排列' : null,
  }
}

export interface BoothQuery {
  eventId: string
  search: string
  offset: number
  limit: number
  sort: 'name' | 'location' | 'genre'
  direction: 'asc' | 'desc'
  days: string[] | null
  halls: string[] | null
  genres: (string | null)[] | null
}

export class BoothFilterError extends Error {}

export function parseBoothQuery(params: URLSearchParams): BoothQuery {
  for (const key of params.keys()) {
    if (!['eventId', 'search', 'offset', 'limit', 'sort', 'direction', 'days', 'halls', 'genres'].includes(key) || params.getAll(key).length !== 1) {
      throw new Error('列表查询包含未知或重复参数')
    }
  }
  const eventId = params.get('eventId') ?? ''
  if (!/^\d{1,32}$/.test(eventId)) throw new Error('eventId 必须是活动 ID')
  const search = (params.get('search') ?? '').trim()
  if (search.length > 255) throw new Error('搜索文本不能超过 255 个字符')
  function integer(key: string, fallback: number, min: number, max: number) {
    const value = params.get(key)
    if (value === null) return fallback
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new Error(`${key} 超出范围`)
    }
    return Number(value)
  }
  const sort = params.get('sort') ?? 'location'
  const direction = params.get('direction') ?? 'asc'
  if (sort !== 'name' && sort !== 'location' && sort !== 'genre') throw new Error('无效的排序字段')
  if (direction !== 'asc' && direction !== 'desc') throw new Error('无效的排序方向')
  function filter(key: string, pattern: RegExp) {
    const value = params.get(key)
    if (value === null) return null
    if (value === '') return []
    const items = [...new Set(value.split(','))]
    if (items.length > 32 || items.some(item => !pattern.test(item))) throw new Error(`${key} 筛选值无效`)
    return items
  }
  let genres: (string | null)[] | null = null
  if (params.has('genres')) {
    const parsed: unknown = JSON.parse(params.get('genres')!)
    if (!Array.isArray(parsed) || parsed.length > 512
      || !parsed.every((item: unknown) => item === null || (typeof item === 'string' && item.length <= 255))) {
      throw new Error('genres 筛选值无效')
    }
    genres = [...new Set<string | null>(parsed)]
  }
  return {
    eventId, search, sort, direction,
    offset: integer('offset', 0, 0, 1_000_000),
    limit: integer('limit', 40, 1, 100),
    days: filter('days', /^[月火水木金土日]$/),
    halls: filter('halls', /^[東西南北](?:\d+|（未匹配）)$/),
    genres,
  }
}
