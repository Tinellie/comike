import type { BoothStatus, PreviewBlockEdge, PreviewBooth } from './data'

export interface MatrixGrid {
  rows: number
  columns: number
}

type Cell = Pick<PreviewBooth, 'bbox' | 'status'>

function snap(spans: [number, number][]): Map<number, number> {
  const protectedSpans = new Set(spans.map(span => span.join(',')))
  const groups: number[][] = []
  for (const value of [...new Set(spans.flat())].sort((a, b) => a - b)) {
    const previous = groups[groups.length - 1]
    if (previous && value - previous[0] <= 1 && !previous.some(other => protectedSpans.has(`${other},${value}`))) {
      previous.push(value)
    } else {
      groups.push([value])
    }
  }
  return new Map(groups.flatMap(group => group.map(value => [value, (group[0] + group[group.length - 1]) / 2])))
}

function snappedCells(cells: Cell[]) {
  const xs = snap(cells.map(({ bbox: b }) => [b.x, b.x + b.width - 1]))
  const ys = snap(cells.map(({ bbox: b }) => [b.y, b.y + b.height - 1]))
  const get = (map: Map<number, number>, key: number) => {
    const value = map.get(key)
    if (value === undefined) throw new Error('Block 坐标对齐失败')
    return value
  }
  return cells.map(({ bbox: b, status }) => ({
    left: get(xs, b.x), right: get(xs, b.x + b.width - 1),
    top: get(ys, b.y), bottom: get(ys, b.y + b.height - 1), status,
  }))
}

export function inferMatrixGrid(cells: Cell[]): MatrixGrid | null {
  if (!cells.length) return null
  const snapped = snappedCells(cells)
  const xs = [...new Set(snapped.flatMap(b => [b.left, b.right]))].sort((a, b) => a - b)
  const ys = [...new Set(snapped.flatMap(b => [b.top, b.bottom]))].sort((a, b) => a - b)
  if (xs.length < 2 || ys.length < 2 || (xs.length - 1) * (ys.length - 1) !== cells.length) return null
  for (const values of [xs, ys]) {
    const step = (values[values.length - 1] - values[0]) / (values.length - 1)
    if (values.some((value, i) => Math.abs(value - (values[0] + i * step)) > 1e-8)) return null
  }
  const occupied = new Set<string>()
  for (const b of snapped) {
    const x = xs.indexOf(b.left)
    const y = ys.indexOf(b.top)
    const key = `${x},${y}`
    if (b.right !== xs[x + 1] || b.bottom !== ys[y + 1] || occupied.has(key)) return null
    occupied.add(key)
  }
  return { rows: ys.length - 1, columns: xs.length - 1 }
}

export function blockGeometry(cells: Cell[], bbox: PreviewBooth['bbox'], grid: MatrixGrid | null) {
  const outline: PreviewBlockEdge[] = []
  const dividers: PreviewBlockEdge[] = []
  if (grid !== null && new Set(cells.map(b => b.status)).size === 1) {
    const right = bbox.x + bbox.width - 1
    const bottom = bbox.y + bbox.height - 1
    const status = cells[0].status
    for (let row = 0; row <= grid.rows; row++) {
      const y = bbox.y + row * (bbox.height - 1) / grid.rows
      ;(row === 0 || row === grid.rows ? outline : dividers).push({ x1: bbox.x, y1: y, x2: right, y2: y, status })
    }
    for (let column = 0; column <= grid.columns; column++) {
      const x = bbox.x + column * (bbox.width - 1) / grid.columns
      ;(column === 0 || column === grid.columns ? outline : dividers).push({ x1: x, y1: bbox.y, x2: x, y2: bottom, status })
    }
    return { outline, dividers }
  }
  type Segment = { start: number; end: number; side: number; status: BoothStatus }
  const lines = new Map<string, { axis: 'h' | 'v'; coordinate: number; segments: Segment[] }>()
  const add = (axis: 'h' | 'v', coordinate: number, start: number, end: number, side: number, status: BoothStatus) => {
    const key = `${axis}:${coordinate}`
    const line = lines.get(key) ?? { axis, coordinate, segments: [] }
    line.segments.push({ start, end, side, status })
    lines.set(key, line)
  }
  for (const b of snappedCells(cells)) {
    add('h', b.top, b.left, b.right, -1, b.status)
    add('h', b.bottom, b.left, b.right, 1, b.status)
    add('v', b.left, b.top, b.bottom, -1, b.status)
    add('v', b.right, b.top, b.bottom, 1, b.status)
  }
  const priority: Record<BoothStatus, number> = { recognized: 0, not_run: 1, unrecognized: 2, needs_review: 3 }
  for (const { axis, coordinate, segments } of lines.values()) {
    const stops = [...new Set(segments.flatMap(s => [s.start, s.end]))].sort((a, b) => a - b)
    const merged: (Segment & { internal: boolean })[] = []
    for (let i = 1; i < stops.length; i++) {
      const start = stops[i - 1], end = stops[i]
      const active = segments.filter(s => s.start <= start && s.end >= end)
      if (!active.length) continue
      const internal = new Set(active.map(s => s.side)).size === 2
      const status = active.reduce((best, s) => priority[s.status] > priority[best] ? s.status : best, active[0].status)
      const previous = merged[merged.length - 1]
      if (previous && previous.end === start && previous.internal === internal && previous.status === status) {
        previous.end = end
      } else {
        merged.push({ start, end, side: 0, internal, status })
      }
    }
    for (const s of merged) {
      const edge = axis === 'h'
        ? { x1: s.start, y1: coordinate, x2: s.end, y2: coordinate, status: s.status }
        : { x1: coordinate, y1: s.start, x2: coordinate, y2: s.end, status: s.status }
      ;(s.internal ? dividers : outline).push(edge)
    }
  }
  return { outline, dividers }
}
