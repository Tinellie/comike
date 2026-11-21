import type { OsmRouteSegment } from './osm'
import type { Point } from './viewport'

export function outsideHallKey(codes: readonly (string | null)[]): string | null {
  const parts = [...new Set(codes.filter((code): code is string => code !== null))]
  if (!parts.length || parts.some(code => code[0] !== parts[0][0])) return null
  return parts[0][0].toLowerCase() + parts.map(code => Number(code.slice(1))).sort((a, b) => a - b).join('')
}

type HallEdge = { from: number; to: number; kind: 'indoor' | 'perimeter' }

export function projectOntoSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x, dy = end.y - start.y
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy || 1)))
  const projected = t === 0 ? start : t === 1 ? end : { x: start.x + t * dx, y: start.y + t * dy }
  return { point: projected, t, distance: (point.x - projected.x) ** 2 + (point.y - projected.y) ** 2 }
}

export function projectHallPerimeter(
  nodes: readonly Point[], edges: readonly HallEdge[], route: readonly OsmRouteSegment[],
  onLink?: (hallNode: number, segment: OsmRouteSegment, t: number, point: Point) => void,
): { perimeter: Point[][]; links: Point[][]; disconnected: number } {
  const rim = edges.filter(edge => edge.kind === 'perimeter')
  const indoor = new Set(edges.filter(edge => edge.kind === 'indoor').flatMap(edge => [edge.from, edge.to]))
  const vertices: Point[] = []
  const osmIds = new Map<string, number>()
  function osmVertex(id: string, point: Point) {
    const existing = osmIds.get(id)
    if (existing !== undefined) return existing
    const i = vertices.push(point) - 1
    osmIds.set(id, i)
    return i
  }
  const cuts = route.map(({ from, to, start, end }) => new Map([
    [0, osmVertex(from, start)], [1, osmVertex(to, end)],
  ]))
  const projected = new Map<number, number>()
  const links: Point[][] = []
  for (const id of new Set(rim.flatMap(edge => [edge.from, edge.to]))) {
    const original = nodes[id]
    let best: { segment: number; t: number; point: Point; distance: number } | undefined
    route.forEach(({ start, end }, segment) => {
      const hit = projectOntoSegment(original, start, end)
      if (!best || hit.distance < best.distance) best = { segment, ...hit }
    })
    if (!best) continue
    const { segment, t, point, distance } = best
    let vertex = cuts[segment].get(t)
    if (vertex === undefined) {
      vertex = vertices.push(point) - 1
      cuts[segment].set(t, vertex)
    }
    projected.set(id, vertex)
    if (indoor.has(id)) {
      onLink?.(id, route[segment], t, point)
      if (distance > 0) links.push([original, point])
    }
  }

  const adjacency = vertices.map(() => new Map<number, number>())
  for (const cut of cuts) {
    const ids = [...cut.entries()].sort(([a], [b]) => a - b).map(([, id]) => id)
    for (let i = 1; i < ids.length; i++) {
      const from = ids[i - 1], to = ids[i]
      const length = Math.hypot(vertices[from].x - vertices[to].x, vertices[from].y - vertices[to].y)
      adjacency[from].set(to, length)
      adjacency[to].set(from, length)
    }
  }

  const perimeter: Point[][] = []
  const drawn = new Set<string>()
  let disconnected = 0
  for (const edge of rim) {
    const from = projected.get(edge.from), to = projected.get(edge.to)
    if (from === undefined || to === undefined) {
      disconnected++
      continue
    }
    if (from === to) continue
    const distance = new Map([[from, 0]])
    const pending = new Set([from])
    const previous = new Map<number, number>()
    while (pending.size) {
      let next = -1, shortest = Infinity
      for (const id of pending) {
        const length = distance.get(id)!
        if (length < shortest) { next = id; shortest = length }
      }
      if (next === to) break
      pending.delete(next)
      for (const [neighbor, length] of adjacency[next]) {
        const total = shortest + length
        if (total >= (distance.get(neighbor) ?? Infinity)) continue
        distance.set(neighbor, total)
        previous.set(neighbor, next)
        pending.add(neighbor)
      }
    }
    if (!previous.has(to)) {
      disconnected++
      continue
    }
    for (let id = to; id !== from;) {
      const prior = previous.get(id)!
      const key = `${Math.min(id, prior)}:${Math.max(id, prior)}`
      if (!drawn.has(key)) {
        drawn.add(key)
        perimeter.push([vertices[prior], vertices[id]])
      }
      id = prior
    }
  }
  return { perimeter, links, disconnected }
}
