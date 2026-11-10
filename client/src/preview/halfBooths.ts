import type { PreviewBooth } from './data'

export interface PreviewHalfBooth {
  id: string
  boothId: string
  suffix: 'a' | 'b' | null
  bbox: PreviewBooth['bbox']
  status: 'resolved' | 'needs_review'
  issues: string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-8
}

export function parseHalfBooths(
  value: unknown, metadata: unknown, booths: PreviewBooth[], assigned: boolean,
): PreviewHalfBooth[] | null {
  if (value === undefined && metadata === undefined) return null
  if (!assigned || !Array.isArray(value) || !record(metadata) || metadata.method !== 'island-neighbor-ab'
    || !record(metadata.counts) || value.length !== booths.length * 2) {
    throw new Error('Half-booth 分割结果格式无效')
  }
  const parents = new Map(booths.map(b => [b.id, b]))
  const ids = new Set<string>()
  const groups = new Map<string, PreviewHalfBooth[]>()
  const halves = value.map((item: unknown): PreviewHalfBooth => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.boothId !== 'string'
      || ids.has(item.id) || !parents.has(item.boothId) || !record(item.bbox)
      || ![`${item.boothId}-h1`, `${item.boothId}-h2`].includes(item.id)
      || (item.suffix !== 'a' && item.suffix !== 'b' && item.suffix !== null)
      || (item.status !== 'resolved' && item.status !== 'needs_review')
      || !Array.isArray(item.issues) || item.issues.some(v => typeof v !== 'string' || !v)
      || (item.status === 'resolved' ? item.suffix === null || item.issues.length !== 0 : item.issues.length === 0)) {
      throw new Error('Half-booth 成员、字母或状态无效')
    }
    const { x, y, width, height } = item.bbox
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
      || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      throw new Error('Half-booth 坐标无效')
    }
    ids.add(item.id)
    const half: PreviewHalfBooth = {
      id: item.id, boothId: item.boothId, suffix: item.suffix, bbox: { x, y, width, height },
      status: item.status, issues: item.issues,
    }
    const group = groups.get(half.boothId) ?? []
    group.push(half)
    groups.set(half.boothId, group)
    return half
  })
  let reviewBooths = 0
  for (const booth of booths) {
    const group = groups.get(booth.id)?.sort((a, b) => a.id.localeCompare(b.id))
    if (!group || group.length !== 2) throw new Error('每个 Booth 必须恰好分成两半')
    const [a, b] = group
    const original = booth.bbox
    const vertical = close(a.bbox.width, original.width / 2) && close(a.bbox.height, original.height)
    const horizontal = close(a.bbox.width, original.width) && close(a.bbox.height, original.height / 2)
    if ((!vertical && !horizontal) || !close(a.bbox.x, original.x) || !close(a.bbox.y, original.y)
      || !close(b.bbox.width, a.bbox.width) || !close(b.bbox.height, a.bbox.height)
      || !close(b.bbox.x, original.x + (vertical ? original.width / 2 : 0))
      || !close(b.bbox.y, original.y + (horizontal ? original.height / 2 : 0))
      || a.status !== b.status || JSON.stringify(a.issues) !== JSON.stringify(b.issues)
      || (a.suffix === null ? b.suffix !== null : b.suffix === null || a.suffix === b.suffix)) {
      throw new Error('Half-booth 必须无重叠、无遗漏地等分原 Booth，并形成 a/b 配对')
    }
    if (a.status === 'needs_review') reviewBooths++
  }
  if (metadata.counts.booths !== booths.length || metadata.counts.halfBooths !== halves.length
    || metadata.counts.reviewBooths !== reviewBooths) {
    throw new Error('Half-booth 统计与实际成员不一致')
  }
  return halves
}
