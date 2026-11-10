import { blockGeometry, inferMatrixGrid } from './blockGeometry'
import { parseHalfBooths } from './halfBooths'
import type { PreviewHalfBooth } from './halfBooths'
import { parseHallOutline } from './hallOutline'
import type { PreviewHallOutline } from './hallOutline'
import { parsePdfPreview } from './pdfPreview'
import type { PdfPreview } from './pdfPreview'

export type BoothStatus = 'recognized' | 'needs_review' | 'unrecognized' | 'not_run'

export interface PreviewBooth {
  id: string
  bbox: { x: number; y: number; width: number; height: number }
  number: string | null
  rotation: number
  status: BoothStatus
  islandId: string | null
  assignment: PreviewMembership | null
  blockId: string | null
}

export interface PreviewBlockEdge {
  x1: number
  y1: number
  x2: number
  y2: number
  status: BoothStatus
}

export interface PreviewBlock {
  id: string
  boothIds: string[]
  bbox: PreviewBooth['bbox']
  islandId: string | null
  outline: PreviewBlockEdge[]
  dividers: PreviewBlockEdge[]
}

export interface PreviewMembership {
  islandId: string
  componentId: string
  status: 'assigned' | 'needs_review'
  issues: string[]
}

export interface PreviewAssignedIsland {
  id: string
  label: string | null
  color: string
  boothIds: string[]
  markerIds: string[]
  componentIds: string[]
  numbers: string[]
  numberGaps: { first: string; last: string }[]
  status: 'assigned' | 'needs_review'
  issues: string[]
}

export interface PreviewAssignment {
  islands: PreviewAssignedIsland[]
  solverStatus: string
  excludedCount: number
  reviewCount: number
  gapCount: number
}

export interface PreviewPage {
  page: number
  width: number
  height: number
  image: string
  booths: PreviewBooth[]
  islandMarkers: PreviewIslandMarker[] | null
  islandInference: PreviewPageInference | null
  islandAssignment: PreviewAssignment | null
  blocks: PreviewBlock[] | null
  venue: PreviewVenue | null
  markerAlignment: { status: 'aligned' | 'centers_only'; aligned: number; centered: number } | null
  halfBooths: PreviewHalfBooth[] | null
  hallOutline?: PreviewHallOutline | null
  pdfPreview?: PdfPreview | null
}

export interface PreviewVenue {
  label: string | null
  rawText: string | null
  recognitionScore: number | null
  status: BoothStatus
  issues: string[]
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
  bbox: PreviewBooth['bbox'] | null
  center: { x: number; y: number }
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

function parseMembership(value: unknown, islandId: unknown): PreviewMembership {
  if (!isRecord(value) || typeof value.islandId !== 'string' || value.islandId !== islandId
    || typeof value.componentId !== 'string' || !isStrings(value.issues)
    || (value.status !== 'assigned' && value.status !== 'needs_review')) {
    throw new Error('Booth 的 Island 归属格式无效')
  }
  return { islandId: value.islandId, componentId: value.componentId, status: value.status, issues: value.issues }
}

function validateExcluded(value: unknown, boothIds: Set<string>): number {
  if (!Array.isArray(value)) throw new Error('缺少排除候选记录')
  const excludedIds = new Set<string>()
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || candidate.status !== 'unrecognized'
      || boothIds.has(candidate.id) || excludedIds.has(candidate.id)) throw new Error('排除候选记录无效')
    excludedIds.add(candidate.id)
  }
  return value.length
}

function parseBlocks(
  value: unknown, booths: PreviewBooth[], width: number, height: number, excluded: unknown, assigned: boolean,
): PreviewBlock[] {
  if (!isRecord(value) || value.method !== 'pixel-edge-connected-components'
    || value.maxBorderPixelDistance !== 1 || !Array.isArray(value.blocks) || !isRecord(value.counts)) {
    throw new Error('Block 分组格式无效')
  }
  const byId = new Map(booths.map(booth => [booth.id, booth]))
  const excludedCount = validateExcluded(excluded, new Set(byId.keys()))
  const seen = new Set<string>()
  const ids = new Set<string>()
  const blocks = value.blocks.map((item: unknown): PreviewBlock => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || !isStrings(item.boothIds) || !item.boothIds.length
      || !Array.isArray(item.outline) || !item.outline.length || !Array.isArray(item.dividers)) {
      throw new Error('Block 轮廓或成员格式无效')
    }
    ids.add(item.id)
    const members = item.boothIds.map(id => {
      const booth = byId.get(id)
      if (!booth || seen.has(id) || booth.blockId !== item.id
        || (assigned && (booth.assignment?.componentId !== item.id || booth.islandId !== item.islandId))) {
        throw new Error('Block 成员缺失、重复或被划分到不同 Island')
      }
      seen.add(id)
      return booth
    })
    const bbox = parseBox(item.bbox, width, height)
    const left = Math.min(...members.map(b => b.bbox.x))
    const top = Math.min(...members.map(b => b.bbox.y))
    if (bbox.x !== left || bbox.y !== top
      || bbox.width !== Math.max(...members.map(b => b.bbox.x + b.bbox.width)) - left
      || bbox.height !== Math.max(...members.map(b => b.bbox.y + b.bbox.height)) - top
      || (assigned && typeof item.islandId !== 'string')) throw new Error('Block 范围或归属无效')
    const lines = new Map<string, [number, number][]>()
    const edges = (values: unknown[]): PreviewBlockEdge[] => values.map((value: unknown) => {
      if (!isRecord(value) || !isStatus(value.status)) throw new Error('Block 边线格式无效')
      const { x1, y1, x2, y2, status } = value
      if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number'
        || ![x1, y1, x2, y2].every(Number.isFinite)
        || x1 < bbox.x || x2 > bbox.x + bbox.width - 1 || y1 < bbox.y || y2 > bbox.y + bbox.height - 1
        || !((x1 === x2 && y2 > y1) || (y1 === y2 && x2 > x1))) {
        throw new Error('Block 边线必须为范围内非零长度的横线或竖线')
      }
      const key = x1 === x2 ? `v:${x1}` : `h:${y1}`
      const intervals = lines.get(key) ?? []
      intervals.push(x1 === x2 ? [y1, y2] : [x1, x2])
      lines.set(key, intervals)
      return { x1, y1, x2, y2, status }
    })
    const outline = edges(item.outline)
    const dividers = edges(item.dividers)
    for (const intervals of lines.values()) {
      intervals.sort((a, b) => a[0] - b[0])
      if (intervals.some((interval, i) => i > 0 && interval[0] < intervals[i - 1][1])) {
        throw new Error('Block 边线重复或重叠')
      }
    }
    return {
      id: item.id, boothIds: item.boothIds, bbox, outline, dividers,
      islandId: assigned && typeof item.islandId === 'string' ? item.islandId : null,
    }
  })
  if (seen.size !== booths.length || value.counts.blocks !== blocks.length
    || value.counts.booths !== booths.length || value.counts.excludedCandidates !== excludedCount) {
    throw new Error('Block 分组不完整或统计不一致')
  }
  return blocks
}

function parseAssignment(
  value: unknown, booths: PreviewBooth[], markers: PreviewIslandMarker[], excluded: unknown,
): PreviewAssignment {
  if (!isRecord(value) || !Array.isArray(value.islands) || !Array.isArray(value.components)
    || !isRecord(value.counts) || !isRecord(value.constraints) || !Array.isArray(excluded)
    || typeof value.solverStatus !== 'string' || !['optimal', 'feasible', 'no_booths'].includes(value.solverStatus)) {
    throw new Error('Island 分组结果格式无效')
  }
  const markerIds = new Set(markers.map(marker => marker.id))
  const byId = new Map(booths.map(booth => [booth.id, booth]))
  const seen = new Set<string>()
  const islandIds = new Set<string>()
  const islands = value.islands.map((item: unknown): PreviewAssignedIsland => {
    if (!isRecord(item) || typeof item.id !== 'string' || islandIds.has(item.id)
      || !isIslandLabel(item.label) || typeof item.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.color)
      || !isStrings(item.boothIds) || !item.boothIds.length
      || !isStrings(item.markerIds) || !item.markerIds.length || item.markerIds.some(id => !markerIds.has(id))
      || !isStrings(item.componentIds) || !item.componentIds.length || !isStrings(item.numbers)
      || !Array.isArray(item.numberGaps) || !isStrings(item.issues) || !isRecord(item.numberRange)
      || (item.status !== 'assigned' && item.status !== 'needs_review')) {
      throw new Error('Island 成员列表格式无效')
    }
    islandIds.add(item.id)
    const numbers: string[] = []
    for (const id of item.boothIds) {
      const booth = byId.get(id)
      if (seen.has(id) || !booth || booth.islandId !== item.id || booth.number === null
        || !booth.assignment || !item.componentIds.includes(booth.assignment.componentId)) {
        throw new Error('Booth 重复分组或归属引用不一致')
      }
      seen.add(id)
      numbers.push(booth.number)
    }
    numbers.sort()
    if (new Set(numbers).size !== numbers.length || JSON.stringify(numbers) !== JSON.stringify(item.numbers)
      || item.numberRange.first !== numbers[0] || item.numberRange.last !== numbers[numbers.length - 1]) {
      throw new Error('Island 内编号重复或编号统计不一致')
    }
    const numberGaps: { first: string; last: string }[] = []
    for (let index = 1; index < numbers.length; index++) {
      const first = Number(numbers[index - 1]) + 1
      const last = Number(numbers[index]) - 1
      if (first <= last) numberGaps.push({ first: String(first).padStart(2, '0'), last: String(last).padStart(2, '0') })
    }
    if (JSON.stringify(numberGaps) !== JSON.stringify(item.numberGaps)) throw new Error('Island 缺号记录与编号不一致')
    return {
      id: item.id, label: item.label, color: item.color, boothIds: item.boothIds,
      markerIds: item.markerIds, componentIds: item.componentIds, numbers, numberGaps,
      status: item.status, issues: item.issues,
    }
  })
  if (seen.size !== booths.length) throw new Error('存在未划分 Island 的 Booth')
  const componentIds = new Set<string>()
  const componentBooths = new Set<string>()
  for (const component of value.components) {
    if (!isRecord(component) || typeof component.id !== 'string' || componentIds.has(component.id)
      || !isStrings(component.boothIds) || !component.boothIds.length) throw new Error('相接格组件格式无效')
    componentIds.add(component.id)
    const grouped = new Set<string>()
    for (const id of component.boothIds) {
      const booth = byId.get(id)
      if (!booth || componentBooths.has(id) || booth.assignment?.componentId !== component.id
        || booth.islandId === null) throw new Error('相接格组件的 Booth 引用无效')
      componentBooths.add(id)
      grouped.add(booth.islandId)
    }
    if (grouped.size !== 1) throw new Error('相接 Booth 被划分到不同 Island')
  }
  if (componentBooths.size !== booths.length || islands.some(island =>
    island.componentIds.some(id => !componentIds.has(id)))) throw new Error('相接格组件不完整')
  validateExcluded(excluded, new Set(byId.keys()))
  const gapCount = islands.reduce((count, island) => count + island.numberGaps.length, 0)
  const reviewCount = booths.filter(booth => booth.assignment?.status === 'needs_review').length
  if (value.counts.assignedBooths !== booths.length || value.counts.islands !== islands.length
    || value.counts.excludedCandidates !== excluded.length || value.counts.numberGaps !== gapCount
    || value.counts.contactComponents !== componentIds.size || value.counts.reviewBooths !== reviewCount
    || value.constraints.allBoothsAssigned !== true || value.constraints.touchingBoothsTogether !== true
    || value.constraints.uniqueNumbers !== true || value.constraints.continuousNumbers !== (gapCount === 0)) {
    throw new Error('Island 分组统计或约束校验不一致')
  }
  return {
    islands, solverStatus: value.solverStatus, excludedCount: excluded.length, reviewCount, gapCount,
  }
}

function parseVenue(value: unknown): PreviewVenue | null {
  if (value === undefined) return null
  if (!isRecord(value) || !isStatus(value.status) || !isStrings(value.issues)
    || !(value.rawText === null || typeof value.rawText === 'string')
    || !(value.recognitionScore === null || isProbability(value.recognitionScore))
    || !(value.label === null || (typeof value.label === 'string' && /^[東西南北][1-9][0-9]*$/.test(value.label)))
    || ((value.status === 'recognized' || value.status === 'needs_review')
      ? value.label === null || value.recognitionScore === null
      : value.label !== null || value.recognitionScore !== null)
    || (value.status === 'recognized' ? value.issues.length !== 0
      : value.status !== 'not_run' && value.issues.length === 0)) {
    throw new Error('场馆编号识别数据格式无效')
  }
  return {
    label: value.label, rawText: value.rawText, recognitionScore: value.recognitionScore,
    status: value.status, issues: value.issues,
  }
}

function parsePage(value: unknown, version: number): PreviewPage {
  if (!isRecord(value) || !positiveInteger(value.page) || !positiveInteger(value.width)
    || !positiveInteger(value.height) || typeof value.image !== 'string'
    || !/^page-\d{3}\.png$/.test(value.image) || !Array.isArray(value.booths)) {
    throw new Error('地图页数据格式无效')
  }
  const width = value.width
  const height = value.height
  const hasAssignment = version === 4 || (version >= 5 && value.islandAssignment !== undefined)
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
    const assignment = hasAssignment ? parseMembership(item.assignment, item.islandId) : null
    if (hasAssignment && (item.number === null || item.status === 'unrecognized' || item.status === 'not_run')) {
      throw new Error('分组结果中的 Booth 必须有有效识别编号')
    }
    if (version >= 5 && (typeof item.blockId !== 'string' || !item.blockId || item.status === 'unrecognized')) {
      throw new Error('Booth 的 Block 引用无效')
    }
    return {
      id: item.id, number: item.number, rotation: item.rotation,
      status: item.status, bbox: parseBox(item.bbox, width, height),
      islandId: assignment?.islandId ?? null, assignment,
      blockId: version >= 5 && typeof item.blockId === 'string' ? item.blockId : null,
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
      let bbox: PreviewBooth['bbox'] | null = null
      let center: PreviewIslandMarker['center']
      if (version >= 7) {
        if ('bbox' in item || !isRecord(item.center) || typeof item.center.x !== 'number'
          || typeof item.center.y !== 'number' || !Number.isFinite(item.center.x) || !Number.isFinite(item.center.y)
          || item.center.x < 0 || item.center.y < 0 || item.center.x > width - 1 || item.center.y > height - 1) {
          throw new Error('Island 标记中心点无效')
        }
        center = { x: item.center.x, y: item.center.y }
      } else {
        bbox = parseBox(item.bbox, width, height)
        center = { x: bbox.x + (bbox.width - 1) / 2, y: bbox.y + (bbox.height - 1) / 2 }
      }
      const inference = version === 3 || (version >= 4 && item.inference !== undefined)
        ? parseMarkerInference(item.inference) : null
      if (inference && (inference.outcome === 'corrected' || inference.outcome === 'confirmed')
        && (inference.proposedLabel === null || inference.proposedLabel !== item.label
          || (inference.outcome === 'confirmed') !== (inference.original.label === item.label))) {
        throw new Error('Island 校正文字与记录不一致')
      }
      return {
        id: item.id, bbox, center, color: item.color,
        label: item.label, status: item.status, recognitionScore: item.recognitionScore,
        issues: item.issues, inference,
      }
    })
  }
  const islandInference = (version === 3 || (version >= 4 && value.islandInference !== undefined)) && islandMarkers !== null
    ? parsePageInference(value.islandInference, islandMarkers) : null
  if (islandMarkers) {
    const markerIds = new Set(islandMarkers.map(marker => marker.id))
    for (const marker of islandMarkers) {
      if (marker.inference?.supportingIds.some(id => id === marker.id || !markerIds.has(id))) {
        throw new Error('Island 校正引用了无效的邻近标记')
      }
    }
  }
  const islandAssignment = hasAssignment && islandMarkers !== null
    ? parseAssignment(value.islandAssignment, booths, islandMarkers, value.excludedCandidates) : null
  const blocks = version >= 5
    ? parseBlocks(value.blockGrouping, booths, width, height, value.excludedCandidates, hasAssignment) : null
  let markerAlignment: PreviewPage['markerAlignment'] = null
  if (version >= 7) {
    const alignment = value.markerAlignment
    if (!isRecord(alignment) || alignment.method !== 'local-center-lines'
      || (alignment.status !== 'aligned' && alignment.status !== 'centers_only')
      || alignment.status !== (hasAssignment ? 'aligned' : 'centers_only') || !isRecord(alignment.counts)
      || typeof alignment.counts.markers !== 'number'
      || alignment.counts.markers !== islandMarkers?.length
      || !Number.isInteger(alignment.counts.aligned) || typeof alignment.counts.aligned !== 'number'
      || !Number.isInteger(alignment.counts.centered) || typeof alignment.counts.centered !== 'number'
      || alignment.counts.aligned < 0 || alignment.counts.aligned > alignment.counts.markers
      || alignment.counts.centered < 0 || alignment.counts.centered > alignment.counts.aligned
      || (!hasAssignment && alignment.counts.aligned !== 0)) {
      throw new Error('Island 标记对齐统计无效')
    }
    markerAlignment = {
      status: alignment.status, aligned: alignment.counts.aligned, centered: alignment.counts.centered,
    }
    if (!Array.isArray(value.islands)) throw new Error('缺少 Island 布局分类')
    for (const kind of ['wall', 'interior', 'uncertain']) {
      if (value.islands.some(island => !isRecord(island)
        || !['wall', 'interior', 'uncertain'].includes(String(island.layoutKind)))) {
        throw new Error('Island 布局分类无效')
      }
      const count = value.islands.filter(island => isRecord(island) && island.layoutKind === kind).length
      if ((alignment.counts[kind] ?? 0) !== count) throw new Error('Island 布局分类统计不一致')
    }
  }
  return {
    page: value.page, width, height, image: value.image, booths, islandMarkers, islandInference, islandAssignment, blocks,
    venue: parseVenue(value.venue),
    markerAlignment,
    halfBooths: parseHalfBooths(value.halfBooths, value.halfBoothSplitting, booths, hasAssignment),
    hallOutline: parseHallOutline(value.hallOutline, width, height),
    pdfPreview: parsePdfPreview(value.pdfPreview, value.page),
  }
}

export function parsePreviewData(data: unknown): PreviewPage[] {
  if (!isRecord(data) || (data.schemaVersion !== 1 && data.schemaVersion !== 2 && data.schemaVersion !== 3
    && data.schemaVersion !== 4 && data.schemaVersion !== 5 && data.schemaVersion !== 6 && data.schemaVersion !== 7)
    || !Array.isArray(data.pages) || !data.pages.length
    || !isRecord(data.coordinateSystem) || data.coordinateSystem.origin !== 'top-left'
    || data.coordinateSystem.unit !== 'source-image-pixel') {
    throw new Error('不支持的识别结果格式或坐标系')
  }
  const version = data.schemaVersion
  const pages = data.pages.map(value => parsePage(version >= 6 ? expandNormalizedPage(value) : value, version))
    .sort((a, b) => a.page - b.page)
  if (new Set(pages.map(page => page.page)).size !== pages.length) throw new Error('地图页码重复')
  return pages
}

function expandNormalizedPage(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !positiveInteger(value.width) || !positiveInteger(value.height)
    || !Array.isArray(value.booths) || !Array.isArray(value.blocks) || !Array.isArray(value.islands)
    || !isRecord(value.blockGrouping) || 'blocks' in value.blockGrouping) {
    throw new Error('精简地图必须包含 Booth、Block、Island 数组')
  }
  const width = value.width, height = value.height
  const booths = new Map<string, Record<string, unknown>>()
  for (const item of value.booths) {
    if (!isRecord(item) || typeof item.id !== 'string' || booths.has(item.id)
      || ['blockId', 'islandId', 'assignment'].some(key => key in item) || !isStatus(item.status)) {
      throw new Error('精简 Booth 不得包含重复 ID 或反向归属')
    }
    booths.set(item.id, { ...item })
  }
  const assigned = value.islandAssignment !== undefined
  if (assigned && (!isRecord(value.islandAssignment) || 'components' in value.islandAssignment
    || 'islands' in value.islandAssignment || !isRecord(value.islandAssignment.assignmentReviews))) {
    throw new Error('精简 Island 求解元数据格式无效')
  }
  const metadata = isRecord(value.islandAssignment) ? value.islandAssignment : null
  const reviews = metadata && isRecord(metadata.assignmentReviews) ? metadata.assignmentReviews : {}
  for (const [id, issues] of Object.entries(reviews)) {
    if (!booths.has(id) || !isStrings(issues) || !issues.length) throw new Error('归属复核记录无效')
  }
  const blockIds = new Set<string>()
  const seen = new Set<string>()
  const blocks = value.blocks.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string' || blockIds.has(item.id)
      || !isStrings(item.boothIds) || !item.boothIds.length
      || ['outline', 'dividers', 'islandId'].some(key => key in item)) throw new Error('精简 Block 格式无效')
    blockIds.add(item.id)
    const cells = item.boothIds.map(id => {
      const booth = booths.get(id)
      if (!booth || seen.has(id) || !isStatus(booth.status)) throw new Error('Block 的 Booth 缺失或重复')
      seen.add(id)
      booth.blockId = item.id
      return { bbox: parseBox(booth.bbox, width, height), status: booth.status }
    })
    const bbox = parseBox(item.bbox, width, height)
    const grid = inferMatrixGrid(cells)
    if (!(item.grid === null && grid === null) && !(isRecord(item.grid) && grid !== null
      && item.grid.rows === grid.rows && item.grid.columns === grid.columns)) {
      throw new Error('Block 矩阵行列数与 Booth 几何不一致')
    }
    if (assigned && (!['horizontal', 'vertical'].includes(String(item.axis)) || typeof item.thin !== 'boolean')) {
      throw new Error('Block 排列特征无效')
    }
    return { ...item, id: item.id, boothIds: item.boothIds, ...blockGeometry(cells, bbox, grid) }
  })
  if (seen.size !== booths.size) throw new Error('存在未分组 Block 的 Booth')
  const blocksById = new Map(blocks.map(b => [b.id, b]))
  const owned = new Set<string>()
  const islands = value.islands.map((item: unknown) => {
    if (!assigned || !isRecord(item) || typeof item.id !== 'string' || !isStrings(item.blockIds)
      || !item.blockIds.length || 'boothIds' in item || 'componentIds' in item) {
      throw new Error('精简 Island 必须仅通过 blockIds 指定成员')
    }
    const boothIds: string[] = []
    for (const id of item.blockIds) {
      const block = blocksById.get(id)
      if (!block || owned.has(id)) throw new Error('Island 的 Block 缺失或重复')
      owned.add(id)
      Object.assign(block, { islandId: item.id })
      for (const boothId of block.boothIds) {
        const booth = booths.get(boothId)
        if (!booth) throw new Error('Block 引用了无效 Booth')
        booth.islandId = item.id
        booth.assignment = {
          islandId: item.id, componentId: id,
          status: Object.hasOwn(reviews, boothId) ? 'needs_review' : 'assigned',
          issues: reviews[boothId] ?? [],
        }
        boothIds.push(boothId)
      }
    }
    return { ...item, boothIds, componentIds: item.blockIds }
  })
  if ((assigned && owned.size !== blocks.length) || (!assigned && Object.keys(reviews).length)) {
    throw new Error('存在未划分 Island 的 Block')
  }
  return {
    ...value, booths: [...booths.values()],
    blockGrouping: { ...value.blockGrouping, blocks },
    ...(metadata ? { islandAssignment: { ...metadata, islands, components: blocks } } : {}),
  }
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
