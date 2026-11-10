export type BoothStatus = 'recognized' | 'needs_review' | 'unrecognized' | 'not_run'

export interface PreviewBooth {
  id: string
  bbox: { x: number; y: number; width: number; height: number }
  number: string | null
  rotation: number
  status: BoothStatus
}

export interface PreviewPage {
  page: number
  width: number
  height: number
  image: string
  booths: PreviewBooth[]
}

export const statusColors: Record<BoothStatus, string> = {
  recognized: '#159447',
  needs_review: '#e08000',
  unrecognized: '#df2020',
  not_run: '#2275dd',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parsePage(value: unknown): PreviewPage {
  if (!isRecord(value) || !positiveInteger(value.page) || !positiveInteger(value.width)
    || !positiveInteger(value.height) || typeof value.image !== 'string'
    || !/^page-\d{3}\.png$/.test(value.image) || !Array.isArray(value.booths)) {
    throw new Error('地图页数据格式无效')
  }
  const width = value.width
  const height = value.height
  const ids = new Set<string>()
  const booths = value.booths.map((item: unknown): PreviewBooth => {
    if (!isRecord(item) || typeof item.id !== 'string' || ids.has(item.id)
      || !(item.number === null || (typeof item.number === 'string' && /^[0-9]{2}$/.test(item.number)))
      || typeof item.rotation !== 'number' || ![0, 90, 180, 270].includes(item.rotation)
      || typeof item.status !== 'string' || !Object.hasOwn(statusColors, item.status)
      || !isRecord(item.bbox)) {
      throw new Error('图格识别数据格式无效')
    }
    const { x, y, width: w, height: h } = item.bbox
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0
      || typeof y !== 'number' || !Number.isSafeInteger(y) || y < 0
      || !positiveInteger(w) || !positiveInteger(h) || x + w > width || y + h > height) {
      throw new Error('图格坐标超出地图范围')
    }
    ids.add(item.id)
    return {
      id: item.id, number: item.number, rotation: item.rotation,
      status: item.status as BoothStatus, bbox: { x, y, width: w, height: h },
    }
  })
  return { page: value.page, width, height, image: value.image, booths }
}

export class PreviewRepository {
  async load(signal: AbortSignal): Promise<PreviewPage[]> {
    const response = await fetch('/api/preview/result.json', { signal })
    if (!response.ok) {
      throw new Error(`无法加载识别结果（HTTP ${response.status}）。请先生成 official-map 识别输出。`)
    }
    const data: unknown = await response.json()
    if (!isRecord(data) || data.schemaVersion !== 1 || !Array.isArray(data.pages) || !data.pages.length
      || !isRecord(data.coordinateSystem) || data.coordinateSystem.origin !== 'top-left'
      || data.coordinateSystem.unit !== 'source-image-pixel') {
      throw new Error('不支持的识别结果格式或坐标系')
    }
    const pages = data.pages.map(parsePage).sort((a, b) => a.page - b.page)
    if (new Set(pages.map(page => page.page)).size !== pages.length) {
      throw new Error('地图页码重复')
    }
    return pages
  }
}
