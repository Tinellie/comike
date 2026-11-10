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
  islandMarkers: PreviewIslandMarker[] | null
  islandInference: PreviewPageInference | null
}

export type IslandLabelType = 'uppercase' | 'lowercase' | 'hiragana' | 'katakana'
type InferenceOutcome = 'corrected' | 'confirmed' | 'unresolved' | 'not_needed' | 'skipped'

export interface PreviewMarkerInference {
  outcome: InferenceOutcome
  original: { label: string | null; status: BoothStatus; issues: string[] }
  proposedLabel: string | null
  score: number
  supportingIds: string[]
  reason: string
  resolvedIssues: string[]
}

export interface PreviewPageInference {
  type: IslandLabelType | null
  confidence: number
  outcomes: Partial<Record<InferenceOutcome, number>>
}

export interface PreviewIslandMarker {
  id: string
  bbox: PreviewBooth['bbox']
  color: string
  label: string | null
  status: BoothStatus
  recognitionScore: number | null
  issues: string[]
  inference: PreviewMarkerInference | null
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

function parseBox(value: unknown, width: number, height: number): PreviewBooth['bbox'] {
  if (!isRecord(value)) throw new Error('标注坐标格式无效')
  const { x, y, width: w, height: h } = value
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0
    || typeof y !== 'number' || !Number.isSafeInteger(y) || y < 0
    || !positiveInteger(w) || !positiveInteger(h) || x + w > width || y + h > height) {
    throw new Error('标注坐标超出地图范围')
  }
  return { x, y, width: w, height: h }
}

function isStatus(value: unknown): value is BoothStatus {
  return typeof value === 'string' && Object.hasOwn(statusColors, value)
}

const labelTypes = ['uppercase', 'lowercase', 'hiragana', 'katakana'] as const
const inferenceOutcomes = ['corrected', 'confirmed', 'unresolved', 'not_needed', 'skipped'] as const

function isIslandLabel(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Za-z\u3041-\u3096\u30a1-\u30fa\u30fc]$/u.test(value))
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function isOutcome(value: unknown): value is InferenceOutcome {
  return inferenceOutcomes.some(outcome => outcome === value)
}

function parseMarkerInference(value: unknown): PreviewMarkerInference {
  if (!isRecord(value) || !isOutcome(value.outcome)
    || !isRecord(value.original) || !isIslandLabel(value.original.label)
    || !isStatus(value.original.status) || !isStrings(value.original.issues)
    || !isIslandLabel(value.proposedLabel) || !isProbability(value.score)
    || !isStrings(value.supportingIds) || typeof value.reason !== 'string'
    || !isStrings(value.resolvedIssues)) {
    throw new Error('Island 校正记录格式无效')
  }
  return {
    outcome: value.outcome,
    original: { label: value.original.label, status: value.original.status, issues: value.original.issues },
    proposedLabel: value.proposedLabel, score: value.score, supportingIds: value.supportingIds,
    reason: value.reason, resolvedIssues: value.resolvedIssues,
  }
}

function parsePageInference(value: unknown, markers: PreviewIslandMarker[]): PreviewPageInference {
  if (!isRecord(value) || !(value.type === null || labelTypes.some(type => type === value.type))
    || !isProbability(value.confidence) || !isRecord(value.outcomes)
    || !isRecord(value.votes) || !isRecord(value.counts) || !isRecord(value.distinctLabels)
    || typeof value.reason !== 'string') {
    throw new Error('Island 页面类型推断格式无效')
  }
  for (const key of labelTypes) {
    for (const field of ['votes', 'counts', 'distinctLabels'] as const) {
      const record = value[field]
      if (!isRecord(record) || typeof record[key] !== 'number'
        || !Number.isFinite(record[key]) || record[key] < 0
        || (field !== 'votes' && !Number.isSafeInteger(record[key]))) {
        throw new Error('Island 页面统计格式无效')
      }
    }
  }
  const outcomes: Partial<Record<InferenceOutcome, number>> = {}
  for (const [key, count] of Object.entries(value.outcomes)) {
    if (!isOutcome(key) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
      || count !== markers.filter(marker => marker.inference?.outcome === key).length) {
      throw new Error('Island 校正统计不一致')
    }
    outcomes[key] = count
  }
  if (Object.values(outcomes).reduce((sum, count) => sum + count, 0) !== markers.length) {
    throw new Error('Island 校正统计不完整')
  }
  const type = labelTypes.find(type => type === value.type) ?? null
  return { type, confidence: value.confidence, outcomes }
}

function parsePage(value: unknown, version: number): PreviewPage {
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
      || !isStatus(item.status)
      || !isRecord(item.bbox)) {
      throw new Error('图格识别数据格式无效')
    }
    ids.add(item.id)
    return {
      id: item.id, number: item.number, rotation: item.rotation,
      status: item.status, bbox: parseBox(item.bbox, width, height),
    }
  })
  let islandMarkers: PreviewIslandMarker[] | null = null
  if (version >= 2) {
    if (!Array.isArray(value.islandMarkers)) throw new Error('缺少 Island 标记识别结果')
    islandMarkers = value.islandMarkers.map((item: unknown): PreviewIslandMarker => {
      if (!isRecord(item) || typeof item.id !== 'string' || ids.has(item.id)
        || typeof item.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.color)
        || !isIslandLabel(item.label)
        || !isStatus(item.status)
        || !(item.recognitionScore === null || isProbability(item.recognitionScore))
        || !isStrings(item.issues)) {
        throw new Error('Island 标记数据格式无效')
      }
      ids.add(item.id)
      const inference = version >= 3 ? parseMarkerInference(item.inference) : null
      if (inference && (inference.outcome === 'corrected' || inference.outcome === 'confirmed')
        && (inference.proposedLabel === null || inference.proposedLabel !== item.label
          || (inference.outcome === 'confirmed') !== (inference.original.label === item.label))) {
        throw new Error('Island 校正文字与记录不一致')
      }
      return {
        id: item.id, bbox: parseBox(item.bbox, width, height), color: item.color,
        label: item.label, status: item.status, recognitionScore: item.recognitionScore,
        issues: item.issues, inference,
      }
    })
  }
  const islandInference = version >= 3 && islandMarkers !== null
    ? parsePageInference(value.islandInference, islandMarkers) : null
  if (islandMarkers) {
    const markerIds = new Set(islandMarkers.map(marker => marker.id))
    for (const marker of islandMarkers) {
      if (marker.inference?.supportingIds.some(id => id === marker.id || !markerIds.has(id))) {
        throw new Error('Island 校正引用了无效的邻近标记')
      }
    }
  }
  return { page: value.page, width, height, image: value.image, booths, islandMarkers, islandInference }
}

export function parsePreviewData(data: unknown): PreviewPage[] {
  if (!isRecord(data) || (data.schemaVersion !== 1 && data.schemaVersion !== 2 && data.schemaVersion !== 3)
    || !Array.isArray(data.pages) || !data.pages.length
    || !isRecord(data.coordinateSystem) || data.coordinateSystem.origin !== 'top-left'
    || data.coordinateSystem.unit !== 'source-image-pixel') {
    throw new Error('不支持的识别结果格式或坐标系')
  }
  const version = data.schemaVersion
  const pages = data.pages.map(value => parsePage(value, version)).sort((a, b) => a.page - b.page)
  if (new Set(pages.map(page => page.page)).size !== pages.length) throw new Error('地图页码重复')
  return pages
}

export class PreviewRepository {
  async load(signal: AbortSignal): Promise<PreviewPage[]> {
    const response = await fetch('/api/preview/result.json', { signal })
    if (!response.ok) {
      throw new Error(`无法加载识别结果（HTTP ${response.status}）。请先生成 official-map 识别输出。`)
    }
    const data: unknown = await response.json()
    return parsePreviewData(data)
  }
}
