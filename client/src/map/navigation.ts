import { inferBoothFacingsFromPaths } from '../preview/boothFacing'
import type { PreviewBooth } from '../preview/data'
import { projectOntoSegment, outsideHallKey, projectHallPerimeter } from './hallPerimeter'
import { hallMatrix } from './halls'
import type { HallTransforms, MapHall } from './halls'
import { featureLevels, hallCodes, tagValues } from './osm'
import type { OsmFeature, OsmMapData, OsmRouteSegment } from './osm'
import { pointInRing } from './viewport'
import type { Point } from './viewport'

type Edge = { from: number; to: number; multiplier: number; oneway?: boolean; levels?: readonly number[]; venueOnly?: boolean; connector?: boolean; ratioable?: boolean }
export type RoutePoint = { edge: Edge; point: Point; origin?: Point; front?: Point; insideHall?: boolean }
type PlannerStop = RoutePoint & { coefficient?: number }
export type RouteStep = { start: Point; end: Point; connector?: boolean }
type HallNavigation = { hall: MapHall; edges: Edge[]; toWorld: (p: Point) => Point }
type Arc = { to: number; cost: number; connectorCost: number; connector?: boolean }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

export function shortestRoute(nodes: Point[], edges: Edge[], start: RoutePoint, end: RoutePoint) {
  const route = nearestRoute(nodes, edges, start, [end], false)
  return route && { points: route.points, cost: route.cost }
}

function approachCost({ origin, front, point }: RoutePoint) {
  if (!origin) return 0
  return front ? distance(origin, front) + distance(front, point) : distance(origin, point)
}

function nearestRoute(nodes: Point[], edges: Edge[], start: RoutePoint, ends: PlannerStop[], planner: boolean) {
  const first = nodes.length
  const points = [...nodes, start.point, ...ends.map(end => end.point)]
  const links: Arc[][] = points.slice(0, first + 1).map(() => [])
  function connect(from: number, to: number, edge: Edge, extra = 0) {
    const travelCost = distance(points[from], points[to]) * edge.multiplier
    links[from].push({ to, cost: travelCost + extra,
      connectorCost: edge.connector && !edge.ratioable ? travelCost : 0, connector: edge.connector })
  }
  const hallOnly = start.insideHall && ends.every(end => end.insideHall)
  for (const edge of edges) {
    if (hallOnly && edge.venueOnly) continue
    connect(edge.from, edge.to, edge)
    if (!edge.oneway) connect(edge.to, edge.from, edge)
  }
  const fraction = ({ edge, point }: RoutePoint) => projectOntoSegment(point, nodes[edge.from], nodes[edge.to]).t
  const startT = fraction(start)
  connect(first, start.edge.to, start.edge)
  if (!start.edge.oneway || startT === 0) connect(first, start.edge.from, start.edge)
  for (const [index, end] of ends.entries()) {
    const last = first + 1 + index, endT = fraction(end)
    const extra = planner ? approachCost(end) : 0
    connect(end.edge.from, last, end.edge, extra)
    if (!end.edge.oneway || endT === 1) connect(end.edge.to, last, end.edge, extra)
    if (start.edge === end.edge && (!start.edge.oneway || startT <= endT)) connect(first, last, start.edge, extra)
  }

  const open = new Set([first])
  const scores = points.map(() => Infinity)
  const connectorCosts = points.map(() => 0)
  const previous = points.map(() => -1)
  const connectors = new Set<number>()
  const maxCoefficient = ends.reduce((max, end) => Math.max(max, end.coefficient ?? 1), 1)
  let winner = -1, bestStopScore = Infinity
  scores[first] = planner ? approachCost(start) : 0
  while (open.size) {
    let current = -1, best = Infinity
    for (const id of open) {
      // Settle by actual cost to keep paths shortest. The scaled cost bounds any eventual planner score.
      const estimate = planner ? scores[id] / maxCoefficient
        : scores[id] + distance(points[id], ends[0].point)
      if (estimate < best) { current = id; best = estimate }
    }
    if (best >= bestStopScore) break
    open.delete(current)
    if (current > first) {
      if (!planner) {
        winner = current
        break
      }
      const coefficient = ends[current - first - 1].coefficient ?? 1
      const fixedCost = connectorCosts[current]
      const score = fixedCost + (scores[current] - fixedCost) / coefficient
      if (score < bestStopScore) { winner = current; bestStopScore = score }
      continue
    }
    for (const { to, cost, connector, connectorCost } of links[current]) {
      const next = scores[current] + cost
      if (next >= scores[to]) continue
      scores[to] = next
      connectorCosts[to] = connectorCosts[current] + connectorCost
      previous[to] = current
      if (connector) connectors.add(to)
      else connectors.delete(to)
      open.add(to)
    }
  }
  if (winner === -1) return null
  const route: Point[] = []
  const steps: RouteStep[] = []
  for (let id = winner; id !== -1; id = previous[id]) {
    route.push(points[id])
    if (previous[id] !== -1) steps.push({ start: points[previous[id]], end: points[id], connector: connectors.has(id) })
  }
  return { points: route.reverse(), steps: steps.reverse(), cost: scores[winner], stopIndex: winner - first - 1 }
}

export function buildNavigation(data: OsmMapData, halls: MapHall[], transforms: HallTransforms, hallLevel: (hall: MapHall) => number) {
  const nodes: Point[] = [], edges: Edge[] = []
  const addNode = (point: Point) => nodes.push(point) - 1
  const connect = (from: number, to: number, multiplier: number) => edges.push({ from, to, multiplier })
  const osmNodes = new Map<string, number>()
  const osmEdges = new Map<string, {
    cuts: Map<number, number>; forward: boolean; backward: boolean; levels: Set<number>; venueOnly: boolean; connector: boolean
    queueDirection: -1 | 0 | 1 | undefined
    ratioable: boolean
  }>()
  const queueDirections = new Map<string, -1 | 0 | 1>()
  for (const [name, segments] of data.queueRoutes ?? []) {
    const queue = directedQueue(segments)
    if (!queue) continue
    for (const { segment: { from, to }, forward } of queue.steps) {
      const key = from < to ? `${from}/${to}` : `${to}/${from}`
      const direction = forward === (from < to) ? 1 : -1
      const existing = queueDirections.get(key)
      if (existing === -direction) console.warn(`OSM navigation: ${name} 在 ${key} 与其他待机列方向冲突，已禁用该路段。`)
      queueDirections.set(key, existing === undefined || existing === direction ? direction : 0)
    }
  }
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
    const pair = ordered ? `${segment.from}/${segment.to}` : `${segment.to}/${segment.from}`
    const key = `${venueOnly}/${pair}`
    let edge = osmEdges.get(key)
    if (!edge) {
      const start = osmNode(segment.from, segment.start), end = osmNode(segment.to, segment.end)
      edge = { cuts: new Map([[0, ordered ? start : end], [1, ordered ? end : start]]),
        forward: false, backward: false, levels: new Set(), venueOnly, connector: false,
        queueDirection: queueDirections.get(pair), ratioable: false }
      osmEdges.set(key, edge)
    }
    const ratioable = segment.connector === true && segment.ratioable === true
    const direction = ratioable ? 0 : segment.direction ?? 0
    edge.forward ||= direction !== (ordered ? -1 : 1)
    edge.backward ||= direction !== (ordered ? 1 : -1)
    edge.connector ||= segment.connector === true
    edge.ratioable ||= ratioable
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
  for (const edge of osmEdges.values()) {
    const { cuts, levels, venueOnly, connector, queueDirection, ratioable } = edge
    const forward = edge.forward && (queueDirection === undefined || queueDirection === 1)
    const backward = edge.backward && (queueDirection === undefined || queueDirection === -1)
    if (!forward && !backward) continue
    const ids = [...cuts].sort(([a], [b]) => a - b).map(([, id]) => id)
    const edgeLevels = [...levels]
    for (let i = 1; i < ids.length; i++) {
      edges.push({ from: forward ? ids[i - 1] : ids[i], to: forward ? ids[i] : ids[i - 1],
        multiplier: 1, oneway: !(forward && backward), levels: edgeLevels, venueOnly, connector,
        ...(ratioable && { ratioable: true }) })
    }
  }
  return { nodes, edges, byHall, osmNodes }
}

export type PlannerSide = '東' | '西南'

function directedQueue(segments: readonly OsmRouteSegment[] | undefined) {
  if (!segments?.length) return null
  const neighbors = new Map<string, OsmRouteSegment[]>()
  for (const segment of segments) {
    for (const id of [segment.from, segment.to]) {
      const adjacent = neighbors.get(id) ?? []
      adjacent.push(segment)
      neighbors.set(id, adjacent)
    }
  }
  const terminals = [...neighbors.keys()].filter(id => neighbors.get(id)?.length === 1)
  if (terminals.length !== 2 || [...neighbors.values()].some(adjacent => adjacent.length > 2)) return null
  const queues = terminals.flatMap(start => {
    const steps: { segment: OsmRouteSegment; forward: boolean }[] = []
    let id = start, previous: OsmRouteSegment | undefined
    for (let i = 0; i < segments.length; i++) {
      const segment = neighbors.get(id)?.find(candidate => candidate !== previous)
      if (!segment) return []
      const forward = segment.from === id
      if (segment.direction === (forward ? -1 : 1)) return []
      steps.push({ segment, forward })
      id = forward ? segment.to : segment.from
      previous = segment
    }
    return [{ exit: id, steps }]
  })
  return queues.length === 1 ? queues[0] : null
}

export function queueStart(
  data: OsmMapData, navigation: ReturnType<typeof buildNavigation>, side: PlannerSide,
) {
  const queue = directedQueue(data.queueRoutes?.get(`${side}待機列`))
  if (!queue) return null
  const { exit, steps } = queue
  const entry = steps.findLastIndex(({ segment }) => !segment.venueEntry) + 1
  const points = [steps[0].forward ? steps[0].segment.start : steps[0].segment.end,
    ...steps.map(({ segment, forward }) => forward ? segment.end : segment.start)].slice(entry)
  const exitNode = navigation.osmNodes.get(exit)
  const edge = navigation.edges.find(({ from, to, oneway }) => from === exitNode || (!oneway && to === exitNode))
  if (exitNode === undefined || !edge) return null
  return { points, start: { edge, point: navigation.nodes[exitNode] } }
}

export function greedyBoothRoute<T extends PlannerStop>(
  { nodes, edges }: Pick<ReturnType<typeof buildNavigation>, 'nodes' | 'edges'>,
  start: RoutePoint, stops: T[],
) {
  const remaining = stops.filter(stop => stop.coefficient !== 0)
  const visited: T[] = []
  const legs: RouteStep[][] = []
  let current = start
  while (remaining.length) {
    const next = nearestRoute(nodes, edges, current, remaining, true)
    if (!next) break
    const stop = remaining.splice(next.stopIndex, 1)[0]
    current = stop
    visited.push(stop)
    legs.push(next.steps)
  }
  return { legs, visited, remaining }
}

export function reorderBoothRoute<T extends RoutePoint>(
  { nodes, edges }: Pick<ReturnType<typeof buildNavigation>, 'nodes' | 'edges'>,
  start: RoutePoint, route: { visited: T[]; legs: RouteStep[][] }, from: number, to: number,
) {
  const visited = [...route.visited]
  visited.splice(to, 0, ...visited.splice(from, 1))
  const oldIndices = new Map(route.visited.map((stop, index) => [stop, index]))
  const legs: RouteStep[][] = []
  for (const [index, stop] of visited.entries()) {
    const previous = visited[index - 1] ?? start
    const oldIndex = oldIndices.get(stop)!
    if ((route.visited[oldIndex - 1] ?? start) === previous) {
      legs.push(route.legs[oldIndex])
      continue
    }
    const leg = nearestRoute(nodes, edges, previous, [stop], false)
    if (!leg) return null
    legs.push(leg.steps)
  }
  return { visited, legs }
}

export function plannerRouteProgress(legs: readonly (readonly RouteStep[])[]) {
  const lengths = legs.map(leg => leg.map(step => step.connector ? 0 : distance(step.start, step.end)))
  const total = lengths.reduce((sum, leg) => leg.reduce((value, length) => value + length, sum), 0)
  let traveled = 0
  return legs.map((leg, index) => leg.map((step, i) => {
    const from = total ? traveled / total : 0
    traveled += lengths[index][i]
    return { ...step, from, to: total ? traveled / total : 0 }
  }))
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
