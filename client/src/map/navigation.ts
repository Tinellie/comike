import { inferBoothFacingsFromPaths } from '../preview/boothFacing'
import type { PreviewBooth } from '../preview/data'
import { projectOntoSegment, outsideHallKey, projectHallPerimeter } from './hallPerimeter'
import { hallMatrix } from './halls'
import type { HallTransforms, MapHall } from './halls'
import { featureLevels, hallCodes, tagValues } from './osm'
import type { OsmFeature, OsmMapData, OsmRouteSegment } from './osm'
import { pointInRing } from './viewport'
import type { Point } from './viewport'

type Edge = { from: number; to: number; multiplier: number; oneway?: boolean; levels?: readonly number[]; venueOnly?: boolean }
export type RoutePoint = { edge: Edge; point: Point; origin?: Point; front?: Point; insideHall?: boolean }
type HallNavigation = { hall: MapHall; edges: Edge[]; toWorld: (p: Point) => Point }
type Arc = { to: number; cost: number }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

export function shortestRoute(nodes: Point[], edges: Edge[], start: RoutePoint, end: RoutePoint) {
  const first = nodes.length, last = first + 1
  const points = [...nodes, start.point, end.point]
  const links: Arc[][] = points.map(() => [])
  function connect(from: number, to: number, multiplier: number) {
    const cost = distance(points[from], points[to]) * multiplier
    links[from].push({ to, cost })
  }
  const hallOnly = start.insideHall && end.insideHall
  for (const { from, to, multiplier, oneway, venueOnly } of edges) {
    if (hallOnly && venueOnly) continue
    connect(from, to, multiplier)
    if (!oneway) connect(to, from, multiplier)
  }
  const fraction = ({ edge, point }: RoutePoint) => projectOntoSegment(point, nodes[edge.from], nodes[edge.to]).t
  const startT = fraction(start), endT = fraction(end)
  connect(first, start.edge.to, start.edge.multiplier)
  if (!start.edge.oneway || startT === 0) connect(first, start.edge.from, start.edge.multiplier)
  connect(end.edge.from, last, end.edge.multiplier)
  if (!end.edge.oneway || endT === 1) connect(end.edge.to, last, end.edge.multiplier)
  if (start.edge === end.edge && (!start.edge.oneway || startT <= endT)) connect(first, last, start.edge.multiplier)

  const open = new Set([first])
  const scores = points.map(() => Infinity)
  const previous = points.map(() => -1)
  scores[first] = 0
  while (open.size) {
    let current = -1, best = Infinity
    for (const id of open) {
      const estimate = scores[id] + distance(points[id], end.point)
      if (estimate < best) { current = id; best = estimate }
    }
    if (current === last) {
      const route: Point[] = []
      for (let id = last; id !== -1; id = previous[id]) route.push(points[id])
      return { points: route.reverse(), cost: scores[last] }
    }
    open.delete(current)
    for (const { to, cost } of links[current]) {
      const next = scores[current] + cost
      if (next >= scores[to]) continue
      scores[to] = next
      previous[to] = current
      open.add(to)
    }
  }
  return null
}

export function buildNavigation(data: OsmMapData, halls: MapHall[], transforms: HallTransforms, hallLevel: (hall: MapHall) => number) {
  const nodes: Point[] = [], edges: Edge[] = []
  const addNode = (point: Point) => nodes.push(point) - 1
  const connect = (from: number, to: number, multiplier: number) => edges.push({ from, to, multiplier })
  const osmNodes = new Map<string, number>()
  const osmEdges = new Map<string, {
    cuts: Map<number, number>; forward: boolean; backward: boolean; levels: Set<number>; venueOnly: boolean
  }>()
  function osmNode(id: string, point: Point) {
    let vertex = osmNodes.get(id)
    if (vertex === undefined) {
      vertex = addNode(point)
      osmNodes.set(id, vertex)
    }
    return vertex
  }
  function cut(segment: OsmRouteSegment, t: number, point: Point, venueOnly = false) {
    const ordered = segment.from < segment.to
    const key = `${venueOnly}/${ordered ? segment.from : segment.to}/${ordered ? segment.to : segment.from}`
    let edge = osmEdges.get(key)
    if (!edge) {
      const start = osmNode(segment.from, segment.start), end = osmNode(segment.to, segment.end)
      edge = { cuts: new Map([[0, ordered ? start : end], [1, ordered ? end : start]]),
        forward: false, backward: false, levels: new Set(), venueOnly }
      osmEdges.set(key, edge)
    }
    const direction = segment.direction ?? 0
    edge.forward ||= direction !== (ordered ? -1 : 1)
    edge.backward ||= direction !== (ordered ? 1 : -1)
    for (const level of defaultLevel(segment.levels)) edge.levels.add(level)
    const { cuts } = edge
    const fraction = Math.round((ordered ? t : 1 - t) * 1e10) / 1e10
    let vertex = cuts.get(fraction)
    if (vertex === undefined) {
      vertex = addNode(point)
      cuts.set(fraction, vertex)
    }
    return vertex
  }
  for (const segment of data.navigationRoutes ?? []) cut(segment, 0, segment.start)
  for (const segment of data.venueRoutes ?? []) cut(segment, 0, segment.start, true)
  const byHall = new Map<number, HallNavigation>()
  for (const placement of transforms.placements) {
    const hall = halls.find(item => item.index === placement.hallIndex)
    if (!hall?.pathGraph) continue
    const [a, b, c, d, e, f] = hallMatrix(hall, placement)
    const toWorld = ({ x, y }: Point) => ({ x: a * x + c * y + e, y: b * x + d * y + f })
    const world = hall.pathGraph.nodes.map(toWorld)
    const indices = world.map(addNode)
    const indoor = hall.pathGraph.edges.filter(edge => edge.kind === 'indoor')
    const levels = [hallLevel(hall)]
    const hallEdges = indoor.map(({ from, to }) => ({ from: indices[from], to: indices[to], multiplier: 1, levels }))
    edges.push(...hallEdges)
    byHall.set(hall.index, { hall, edges: hallEdges, toWorld })
    const key = outsideHallKey(hall.labels.map(label => label.code))
    const outside = key ? data.outsideHallRoutes.get(key) : undefined
    if (outside?.length) {
      projectHallPerimeter(world, hall.pathGraph.edges, outside, (node, segment, t, point) => {
        connect(indices[node], cut(segment, t, point), 1)
      })
    }
  }
  for (const { cuts, forward, backward, levels, venueOnly } of osmEdges.values()) {
    const ids = [...cuts].sort(([a], [b]) => a - b).map(([, id]) => id)
    const edgeLevels = [...levels]
    for (let i = 1; i < ids.length; i++) {
      edges.push({ from: forward ? ids[i - 1] : ids[i], to: forward ? ids[i] : ids[i - 1],
        multiplier: 1, oneway: !(forward && backward), levels: edgeLevels, venueOnly })
    }
  }
  return { nodes, edges, byHall }
}

function defaultLevel(levels?: readonly number[]) {
  return levels?.length ? levels : [0]
}

export function areaRoutePoint(
  { nodes, edges }: ReturnType<typeof buildNavigation>, features: readonly OsmFeature[],
  origin: Point, selectedLevels: ReadonlySet<number>,
): { target: RoutePoint; error?: never } | { error: string; target?: never } | null {
  const hallLevels = new Set<number>()
  const venueLevels = new Set<number>()
  const entryLevels = new Set<number>()
  for (const { area, tags, paths, bounds } of features) {
    if (!area
      || origin.x < bounds.minX || origin.x > bounds.maxX || origin.y < bounds.minY || origin.y > bounds.maxY
      || !paths.reduce((inside, ring) => inside !== pointInRing(origin, ring), false)) continue
    const levels = featureLevels(tags)
    if (hallCodes(tags).length) {
      for (const level of defaultLevel(levels)) hallLevels.add(level)
    }
    if (!tagValues(tags, 'tokyo-big-sight').includes('yes')) continue
    const entry = Object.keys(tags).some(key => /^path:[^:]+-entry$/.test(key))
    for (const level of defaultLevel(levels)) {
      venueLevels.add(level)
      if (entry) entryLevels.add(level)
    }
  }
  const insideHall = hallLevels.size > 0
  const candidates = [...(insideHall ? hallLevels : venueLevels)]
  const visible = candidates.filter(level => !selectedLevels.size || selectedLevels.has(level))
  const floor = Math.max(...(insideHall && !visible.length ? candidates : visible))
  if (!venueLevels.has(floor)) return null
  if (entryLevels.has(floor)) return { error: '该入口区域不能选点。' }
  let target: RoutePoint | undefined, nearest = Infinity
  for (const edge of edges) {
    if ((insideHall && edge.venueOnly) || !edge.levels?.includes(floor)) continue
    const { point, distance } = projectOntoSegment(origin, nodes[edge.from], nodes[edge.to])
    if (distance >= nearest) continue
    target = { edge, point, origin, insideHall }
    nearest = distance
  }
  return target ? { target } : { error: '该楼层没有可接入的导航路径。' }
}

function crossesBooth(start: Point, end: Point, box: PreviewBooth['bbox']) {
  let low = 0, high = 1
  for (const axis of ['x', 'y'] as const) {
    const min = box[axis] + 0.1
    const max = box[axis] + (axis === 'x' ? box.width : box.height) - 0.1
    const delta = end[axis] - start[axis]
    if (delta === 0) {
      if (start[axis] <= min || start[axis] >= max) return false
      continue
    }
    const a = (min - start[axis]) / delta, b = (max - start[axis]) / delta
    low = Math.max(low, Math.min(a, b))
    high = Math.min(high, Math.max(a, b))
  }
  return low < high
}

export function boothRoutePoint(
  navigation: ReturnType<typeof buildNavigation>, hallIndex: number, booth: PreviewBooth, target: PreviewBooth['bbox'],
) {
  const entry = navigation.byHall.get(hallIndex)
  const graph = entry?.hall.pathGraph
  if (!entry || !graph) return { error: '该场馆没有可用路径图' }
  const { hall, edges, toWorld } = entry
  const hallBounds = hall.page.hallOutline?.polygon
  const localEdges = graph.edges.filter(edge => edge.kind === 'indoor')
  const facing = hallFacings(hall).get(booth.id)?.direction
  if (!facing) return { error: '无法判定该摊位朝向，请选择其他摊位' }
  const { x, y, width, height } = booth.bbox
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
  const anchor = { ...center }
  const axis = facing.x ? 'x' : 'y', sign = facing[axis]
  anchor[axis] = axis === 'x' ? x + (sign > 0 ? width : 0) : y + (sign > 0 ? height : 0)
  const world = toWorld(anchor)
  let best: RoutePoint | undefined, nearest = Infinity
  for (const [i, edge] of localEdges.entries()) {
    let a = graph.nodes[edge.from], b = graph.nodes[edge.to]
    const start = (a[axis] - anchor[axis]) * sign, end = (b[axis] - anchor[axis]) * sign
    if (start <= 0 && end <= 0) continue
    if (start < 0 || end < 0) {
      const t = start / (start - end)
      const cut = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
      if (start < 0) a = cut
      else b = cut
    }
    const hit = projectOntoSegment(world, toWorld(a), toWorld(b))
    const local = { x: a.x + hit.t * (b.x - a.x), y: a.y + hit.t * (b.y - a.y) }
    if (hit.distance >= nearest || (local[axis] - anchor[axis]) * sign <= 0
      || (hallBounds && crossesBoundary(anchor, local, hallBounds))
      || hall.page.booths.some(other => other !== booth && crossesBooth(anchor, local, other.bbox))) continue
    best = { edge: edges[i], point: hit.point, origin: toWorld(center), front: world, insideHall: true }
    nearest = hit.distance
  }
  return best ? { target: best } : { error: '摊位朝向一侧没有可接入的路径' }
}

function crossesBoundary(a: Point, b: Point, polygon: Point[]) {
  const dx = b.x - a.x, dy = b.y - a.y
  return polygon.some((p, index) => {
    const q = polygon[(index + 1) % polygon.length]
    const ex = q.x - p.x, ey = q.y - p.y
    const det = dx * ey - dy * ex
    if (Math.abs(det) < 1e-8) return false
    const x = p.x - a.x, y = p.y - a.y
    const t = (x * ey - y * ex) / det, u = (x * dy - y * dx) / det
    return t > 1e-8 && t < 1 - 1e-8 && u >= 0 && u <= 1
  })
}

const facings = new WeakMap<MapHall, ReturnType<typeof inferBoothFacingsFromPaths>>()
function hallFacings(hall: MapHall) {
  let facing = facings.get(hall)
  if (!facing) {
    const outline = hall.page.hallOutline
    const method = hall.name === '\u897f12' && outline && outline.polygon.length > 4 ? 'layout_notch'
      : hall.name === '\u535712' && outline?.polygon.length === 4 ? 'nonwhite_bbox' : 'closed_frame'
    facing = inferBoothFacingsFromPaths({
      ...hall.page,
      hallOutline: outline && { ...outline, method },
      venue: { label: hall.name, rawText: null, recognitionScore: null, status: 'not_run', issues: [] },
    }, hall.pathGraph?.edges.filter(edge => edge.kind === 'indoor').map(edge => [
      hall.pathGraph!.nodes[edge.from], hall.pathGraph!.nodes[edge.to],
    ]) ?? [])
    facings.set(hall, facing)
  }
  return facing
}
