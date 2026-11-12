import { hallCodes } from './osm'
import type { OsmFeature, OsmMapData } from './osm'
import type { HallPlacement, MapHall } from './halls'
import { projectCoordinate } from './viewport'
import type { Point } from './viewport'

interface Segment { start: Point; end: Point }
interface Similarity { angle: number; scale: number; translation: Point }

export interface HallRegistrationReport {
  hallIndex: number
  name: string | null
  codes: string[]
  orientation: 'markers' | 'boundary'
  rmsErrorMeters: number
  relativeError: number
  axisRmsErrorMeters: number | null
  contained: true
  envelope: Point[]
  alignment: { source: Segment; target: Segment; angleErrorDegrees: number } | null
}

const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x
const interpolate = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
})
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))

function mean(points: Point[]): Point {
  if (!points.length) throw new Error('Hall 拟合点集为空')
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  }
}

function ringSegments(ring: Point[]): Segment[] {
  return ring.map((start, i) => ({ start, end: ring[(i + 1) % ring.length] }))
    .filter(s => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > 1e-8)
}

function inside(point: Point, ring: Point[]): boolean {
  let result = false
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result
  }
  return result
}

function featureRings(feature: OsmFeature, origin: Point): Point[][] {
  return feature.paths.map(path => {
    if (path.length < 4 || path[0].x !== path.at(-1)?.x || path[0].y !== path.at(-1)?.y) {
      throw new Error(`OSM 子馆 ${feature.id} 的轮廓未闭合`)
    }
    return path.slice(0, -1).map(point => subtract(point, origin))
  })
}

function inPolygons(point: Point, polygons: Point[][][]): boolean {
  return polygons.some(rings => rings.reduce((filled, ring) => inside(point, ring) !== filled, false))
}

function segmentCuts(edge: Segment, edges: Segment[]): number[] {
  const r = subtract(edge.end, edge.start), length = Math.hypot(r.x, r.y), cuts = [0, 1]
  for (const other of edges) {
    const s = subtract(other.end, other.start), delta = subtract(other.start, edge.start), divisor = cross(r, s)
    if (Math.abs(divisor) > 1e-9 * length * Math.hypot(s.x, s.y)) {
      const t = cross(delta, s) / divisor, u = cross(delta, r) / divisor
      if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) cuts.push(t)
    } else if (Math.abs(cross(delta, r)) / length < 1e-8) {
      for (const endpoint of [other.start, other.end]) {
        const t = dot(subtract(endpoint, edge.start), r) / dot(r, r)
        if (t > 0 && t < 1) cuts.push(t)
      }
    }
  }
  return [...new Set(cuts)].sort((a, b) => a - b)
}

export function hallUnionBoundary(rings: Point[][], polygons = rings.map(ring => [ring])): Segment[] {
  const edges = rings.flatMap(ringSegments), result = new Map<string, Segment>()
  const inUnion = (point: Point) => inPolygons(point, polygons)
  for (const edge of edges) {
    const r = subtract(edge.end, edge.start), length = Math.hypot(r.x, r.y)
    const cuts = segmentCuts(edge, edges)
    for (let i = 1; i < cuts.length; i++) {
      if ((cuts[i] - cuts[i - 1]) * length < 1e-7) continue
      const start = interpolate(edge.start, edge.end, cuts[i - 1])
      const end = interpolate(edge.start, edge.end, cuts[i])
      const center = interpolate(start, end, 0.5)
      let probe = Math.min(1e-5, length * 0.1)
      let left: boolean, right: boolean
      do {
        const normal = { x: -r.y / length * probe, y: r.x / length * probe }
        left = inUnion({ x: center.x + normal.x, y: center.y + normal.y })
        right = inUnion({ x: center.x - normal.x, y: center.y - normal.y })
        probe /= 2
      } while (left === right && probe > 1e-9)
      if (left === right) continue
      const segment = left ? { start, end } : { start: end, end: start }
      const key = [segment.start.x, segment.start.y, segment.end.x, segment.end.y]
        .map(value => value.toFixed(6)).join(':')
      result.set(key, segment)
    }
  }
  if (result.size < 3) throw new Error('OSM 子馆合并后的外轮廓无效')
  return [...result.values()]
}

function containmentChecker(polygons: Point[][][], boundary: Segment[], tolerance = 1e-7): (source: Point[]) => boolean {
  const edges = polygons.flat(1).flatMap(ringSegments)
  const covered = (point: Point) => inPolygons(point, polygons) || nearest(point, edges).distance < tolerance ** 2
  return source => {
    if (source.length < 3) throw new Error('Hall 包含校验需要有效多边形')
    if (!source.every(covered)) return false
    for (const edge of ringSegments(source)) {
      const cuts = segmentCuts(edge, edges)
      for (let i = 1; i < cuts.length; i++) {
        if (!covered(interpolate(edge.start, edge.end, (cuts[i - 1] + cuts[i]) / 2))) return false
      }
    }
    // A hole may lie wholly inside the source without intersecting any source edge.
    for (const { start, end } of boundary) {
      const vector = subtract(end, start), length = Math.hypot(vector.x, vector.y)
      const middle = interpolate(start, end, 0.5)
      for (let probe = Math.min(1e-5, length * 0.1); probe > tolerance * 2; probe /= 2) {
        const outside = { x: middle.x + vector.y / length * probe, y: middle.y - vector.x / length * probe }
        if (inside(outside, source) && !covered(outside)) return false
      }
    }
    return true
  }
}

export function hallContained(source: Point[], polygons: Point[][][]): boolean {
  const boundary = hallUnionBoundary(polygons.flat(1), polygons)
  return containmentChecker(polygons, boundary)(source)
}

const samePoint = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6
const signedArea = (ring: Point[]) => ringSegments(ring).reduce((sum, edge) =>
  sum + cross(subtract(edge.start, ring[0]), subtract(edge.end, ring[0])), 0) / 2

function simpleRing(ring: Point[]): boolean {
  const edges = ringSegments(ring)
  if (edges.length !== ring.length || signedArea(ring) <= 1e-8) return false
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    if (j === i + 1 || i === 0 && j === edges.length - 1) continue
    const a = edges[i], b = edges[j], r = subtract(a.end, a.start), s = subtract(b.end, b.start)
    const delta = subtract(b.start, a.start), divisor = cross(r, s)
    if (Math.abs(divisor) > 1e-10) {
      const t = cross(delta, s) / divisor, u = cross(delta, r) / divisor
      if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) return false
    } else if (Math.abs(cross(delta, r)) < 1e-8) {
      const low = dot(delta, r) / dot(r, r), high = dot(subtract(b.end, a.start), r) / dot(r, r)
      if (Math.max(Math.min(low, high), 0) <= Math.min(Math.max(low, high), 1)) return false
    }
  }
  return true
}

export function hallEnvelope(polygons: Point[][][]): Point[] {
  const boundary = hallUnionBoundary(polygons.flat(1), polygons), remaining = [...boundary], exterior: Point[][] = []
  while (remaining.length) {
    const first = remaining.shift()
    if (!first) throw new Error('Hall 套索边界缺失')
    const ring = [first.start]
    let end = first.end
    while (!samePoint(end, ring[0])) {
      ring.push(end)
      const index = remaining.findIndex(edge => samePoint(edge.start, end))
      if (index < 0) throw new Error('Hall 套索边界无法连成闭合多边形')
      end = remaining.splice(index, 1)[0].end
    }
    if (signedArea(ring) > 1e-8) exterior.push(ring)
  }
  if (!exterior.length) throw new Error('Hall 套索没有有效外轮廓')
  const subhallExteriors = polygons.flatMap(rings => rings.filter((ring, i) =>
    rings.filter((other, j) => i !== j && inside(ring[0], other)).length % 2 === 0,
  )).map(ring => signedArea(ring) < 0 ? [...ring].reverse() : ring)
  const points = exterior.flat().sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((point, i, list) => i === 0 || !samePoint(point, list[i - 1]))
  const chain = (input: Point[]) => {
    const result: Point[] = []
    for (const point of input) {
      while (result.length > 1 && cross(subtract(result[result.length - 1], result[result.length - 2]), subtract(point, result[result.length - 1])) <= 1e-10) result.pop()
      result.push(point)
    }
    return result.slice(0, -1)
  }
  let hull = [...chain(points), ...chain([...points].reverse())]
  // Tighten a convex enclosure using real exterior chains, never cutting into a subhall.
  for (let iteration = 0; iteration < points.length; iteration++) {
    let best = hull, bestArea = signedArea(hull)
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length]
      const paths: Point[][] = points.filter(point => !hull.some(vertex => samePoint(point, vertex))).map(point => [point])
      // Restore recesses belonging to one subhall, not courtyard chains spanning multiple subhalls.
      for (const ring of subhallExteriors) {
        const start = ring.findIndex(point => samePoint(point, a)), end = ring.findIndex(point => samePoint(point, b))
        if (start < 0 || end < 0) continue
        const path: Point[] = []
        for (let j = (start + 1) % ring.length; j !== end; j = (j + 1) % ring.length) path.push(ring[j])
        if (path.length) paths.push(path)
      }
      for (const path of paths) {
        if (path.some(point => hull.some(vertex => samePoint(point, vertex)))) continue
        const candidate = [...hull.slice(0, i + 1), ...path, ...hull.slice(i + 1)]
        const area = signedArea(candidate)
        if (area >= bestArea - 1e-7 || !simpleRing(candidate)) continue
        const covers = containmentChecker([[candidate]], ringSegments(candidate))
        if (!exterior.every(covers)) continue
        best = candidate
        bestArea = area
      }
    }
    if (best === hull) break
    hull = best
  }
  // Close deep bays between subhalls (open courtyards), retaining broad shallow exterior recesses.
  if (polygons.length > 1) {
    for (let iteration = 0; iteration < points.length; iteration++) {
      const convex = hull.map((point, i) => {
        const before = subtract(point, hull[(i + hull.length - 1) % hull.length])
        const after = subtract(hull[(i + 1) % hull.length], point)
        return cross(before, after) / (Math.hypot(before.x, before.y) * Math.hypot(after.x, after.y)) > Math.sin(Math.PI / 60)
      })
      let changed = false
      for (let i = 0; i < hull.length; i++) {
        if (!convex[i]) continue
        let end = (i + 1) % hull.length
        const path: Point[] = []
        while (!convex[end] && end !== i) { path.push(hull[end]); end = (end + 1) % hull.length }
        if (!path.length || end === i) continue
        const chord = subtract(hull[end], hull[i]), width = Math.hypot(chord.x, chord.y)
        const depth = Math.max(...path.map(point => Math.abs(cross(subtract(point, hull[i]), chord)) / width))
        if (depth <= width / 2) continue
        const candidate: Point[] = [hull[i]]
        for (let j = end; j !== i; j = (j + 1) % hull.length) candidate.push(hull[j])
        if (!simpleRing(candidate) || !exterior.every(containmentChecker([[candidate]], ringSegments(candidate)))) continue
        hull = candidate
        changed = true
        break
      }
      if (!changed) break
    }
  }
  if (!simpleRing(hull) || !polygons.flat(1).every(containmentChecker([[hull]], ringSegments(hull)))) {
    throw new Error('Hall 凹形套索不能完整包裹所有子馆')
  }
  return hull
}

function areaCenter(segments: Segment[]): Point {
  let area = 0, x = 0, y = 0
  for (const { start, end } of segments) {
    const weight = cross(start, end)
    area += weight
    x += (start.x + end.x) * weight
    y += (start.y + end.y) * weight
  }
  if (Math.abs(area) < 1e-6) throw new Error('OSM 子馆轮廓面积无效')
  return { x: x / (3 * area), y: y / (3 * area) }
}

function samples(segments: Segment[], count = 96): Point[] {
  const lengths = segments.map(s => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (total < 1e-6) throw new Error('Hall 轮廓长度无效')
  let index = 0, before = 0
  return Array.from({ length: count }, (_, i) => {
    const distance = (i + 0.5) * total / count
    while (index < segments.length - 1 && before + lengths[index] < distance) before += lengths[index++]
    return interpolate(segments[index].start, segments[index].end, (distance - before) / lengths[index])
  })
}

function nearest(point: Point, segments: Segment[], direction?: Point, angleWeight = 0): {
  point: Point; segment: number; fraction: number; distance: number; cost: number
} {
  let best = { point: segments[0].start, segment: 0, fraction: 0, distance: Infinity, cost: Infinity }
  segments.forEach(({ start, end }, segment) => {
    const vector = subtract(end, start)
    const fraction = Math.max(0, Math.min(1, dot(subtract(point, start), vector) / dot(vector, vector)))
    const candidate = interpolate(start, end, fraction), difference = subtract(point, candidate)
    const distance = dot(difference, difference)
    const angular = direction ? cross(direction, vector) ** 2 / (dot(direction, direction) * dot(vector, vector)) : 0
    const cost = distance + angleWeight * angular
    if (cost < best.cost) best = { point: candidate, segment, fraction, distance, cost }
  })
  return best
}

function apply(point: Point, fit: Similarity): Point {
  const a = fit.scale * Math.cos(fit.angle), b = fit.scale * Math.sin(fit.angle)
  return { x: a * point.x - b * point.y + fit.translation.x, y: b * point.x + a * point.y + fit.translation.y }
}

function similarity(source: Point[], target: Point[], weights = source.map(() => 1), fixedAngle?: number): Similarity {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const center = (points: Point[]): Point => ({
    x: points.reduce((sum, point, i) => sum + point.x * weights[i], 0) / total,
    y: points.reduce((sum, point, i) => sum + point.y * weights[i], 0) / total,
  })
  const s = center(source), t = center(target)
  let cosine = 0, sine = 0, variance = 0
  source.forEach((point, i) => {
    const p = subtract(point, s), q = subtract(target[i], t)
    cosine += dot(p, q) * weights[i]
    sine += cross(p, q) * weights[i]
    variance += dot(p, p) * weights[i]
  })
  const angle = fixedAngle ?? Math.atan2(sine, cosine)
  const scale = fixedAngle === undefined ? Math.hypot(cosine, sine) / variance
    : (cosine * Math.cos(angle) + sine * Math.sin(angle)) / variance
  if (!Number.isFinite(scale) || scale < 1e-8) throw new Error('Hall 对应点不能确定方向或缩放')
  const transformedCenter = apply(s, { angle, scale, translation: { x: 0, y: 0 } })
  return { angle, scale, translation: subtract(t, transformedCenter) }
}

function fitBoundary(
  source: Segment[], target: Segment[], polygons: Point[][][], coarseAngle: number | null,
  minimumScale: number, maximumScale: number, codeCenters: Point[], alignmentTargets: Segment[], extraGeometry: Point[][],
): {
  fit: Similarity; error: number; axisError: number | null; alignment: { source: Segment; target: Segment; angleErrorDegrees: number } | null
} {
  const sourceSamples = samples(source), targetSamples = samples(target)
  const axial = source.map(({ start, end }) => {
    const vector = subtract(end, start), length = Math.hypot(vector.x, vector.y)
    return Math.min(Math.abs(vector.x), Math.abs(vector.y)) < length * 0.001
  })
  const sourceIndices = sourceSamples.map(point => nearest(point, source).segment)
  const s = mean(sourceSamples), t = mean(targetSamples)
  const targetPoints = target.flatMap(edge => [edge.start, edge.end])
  const bounds = {
    minX: Math.min(...targetPoints.map(p => p.x)), maxX: Math.max(...targetPoints.map(p => p.x)),
    minY: Math.min(...targetPoints.map(p => p.y)), maxY: Math.max(...targetPoints.map(p => p.y)),
  }
  const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
  const angleWeight = diagonal ** 2 * 0.16
  const contained = containmentChecker(polygons, target, 1e-9)
  const sourceRing = source.map(edge => edge.start)
  const isContained = (fit: Similarity) => [sourceRing, ...extraGeometry].every(ring => contained(ring.map(point => apply(point, fit))))
  const variance = (points: Point[], center: Point) => points.reduce((sum, p) => {
    const delta = subtract(p, center)
    return sum + dot(delta, delta)
  }, 0)
  const initialScale = Math.sqrt(variance(targetSamples, t) / variance(sourceSamples, s))
  const seeds = coarseAngle === null ? Array.from({ length: 36 }, (_, i) => i * Math.PI / 18)
    : [-45, -30, -15, 0, 15, 30, 45].map(degrees => coarseAngle + degrees * Math.PI / 180)
  const longest = Math.max(...target.map(edge => Math.hypot(edge.end.x - edge.start.x, edge.end.y - edge.start.y)))
  for (const edge of target) {
    const vector = subtract(edge.end, edge.start)
    if (Math.hypot(vector.x, vector.y) < longest * 0.05) continue
    for (const offset of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const angle = Math.atan2(vector.y, vector.x) + offset
      if (coarseAngle !== null && Math.abs(angleDifference(angle, coarseAngle)) > Math.PI / 3) continue
      if (!seeds.some(seed => Math.abs(angleDifference(seed, angle)) < 1e-5)) seeds.push(angle)
    }
  }
  const candidates: { fit: Similarity; cost: number }[] = []
  const score = (fit: Similarity) => {
    const transformed = source.map(edge => ({ start: apply(edge.start, fit), end: apply(edge.end, fit) }))
    let cost = 0, weight = 0
    sourceSamples.forEach((point, i) => {
      const index = sourceIndices[i], axis = axial[index], edge = transformed[index], w = axis ? 4 : 1
      cost += w * nearest(apply(point, fit), target, axis ? subtract(edge.end, edge.start) : undefined, angleWeight).cost
      weight += w
    })
    targetSamples.forEach(point => {
      const nearestSource = nearest(point, transformed), axis = axial[nearestSource.segment]
      const w = axis ? 4 : 1
      cost += w * nearestSource.distance
      weight += w
    })
    return cost / weight
  }
  for (const angle of seeds) {
    const initial = { angle, scale: initialScale, translation: { x: 0, y: 0 } }
    let fit = { ...initial, translation: subtract(t, apply(s, initial)) }, cost = score(fit)
    // Symmetric point-to-segment ICP; exact segments avoid vertex-density bias.
    for (let iteration = 0; iteration < 100; iteration++) {
      const transformed = source.map(edge => ({ start: apply(edge.start, fit), end: apply(edge.end, fit) }))
      const pairs = sourceSamples.map((point, i) => {
        const index = sourceIndices[i], axis = axial[index], edge = transformed[index]
        return {
          source: point, weight: axis ? 4 : 1,
          target: nearest(apply(point, fit), target, axis ? subtract(edge.end, edge.start) : undefined, angleWeight).point,
        }
      })
      for (const point of targetSamples) {
        const closest = nearest(point, transformed), segment = source[closest.segment]
        pairs.push({ source: interpolate(segment.start, segment.end, closest.fraction), target: point, weight: axial[closest.segment] ? 4 : 1 })
      }
      const next = similarity(pairs.map(p => p.source), pairs.map(p => p.target), pairs.map(p => p.weight))
      if (coarseAngle !== null && Math.abs(angleDifference(next.angle, coarseAngle)) > Math.PI / 3) break
      const nextCost = score(next)
      if (nextCost > cost + 1e-9) break
      const improvement = cost - nextCost
      fit = next
      cost = nextCost
      if (improvement < Math.max(1e-10, cost * 1e-7)) break
    }
    candidates.push({ fit, cost })
  }
  candidates.sort((a, b) => a.cost - b.cost)
  const unconstrained = candidates[0]
  if (coarseAngle === null && candidates.some(candidate =>
    Math.abs(angleDifference(candidate.fit.angle, unconstrained.fit.angle)) > Math.PI / 3
    && candidate.cost - unconstrained.cost < Math.max(1e-6, unconstrained.cost * 0.01))) {
    throw new Error('单个子馆的轮廓存在对称方向歧义，无法自动判向，请手动配准')
  }
  const supportingSource = (edge: Segment) => {
    const direction = subtract(edge.end, edge.start), sign = Math.sign(signedArea(sourceRing))
    return [sourceRing, ...extraGeometry].flat().every(point =>
      cross(direction, subtract(point, edge.start)) * sign >= -1e-7,
    )
  }
  const vertical = source.filter(edge => {
    const vector = subtract(edge.end, edge.start)
    return Math.abs(vector.x) < Math.hypot(vector.x, vector.y) * 0.001 && supportingSource(edge)
  }).sort((a, b) => Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y) - Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y))[0]
  const axisEdge = vertical ?? source.filter((edge, i) => axial[i] && supportingSource(edge))[0]
  const locked: { angle: number; edge: Segment; distance: number }[] = []
  if (axisEdge) {
    const vector = subtract(axisEdge.end, axisEdge.start), sourceAngle = Math.atan2(vector.y, vector.x)
    const length = Math.max(...alignmentTargets.map(edge => Math.hypot(edge.end.x - edge.start.x, edge.end.y - edge.start.y)))
    for (const edge of alignmentTargets) {
      const direction = subtract(edge.end, edge.start)
      if (Math.hypot(direction.x, direction.y) < length * 0.1) continue
      for (const offset of [signedArea(sourceRing) > 0 ? 0 : Math.PI]) {
        const angle = Math.atan2(direction.y, direction.x) - sourceAngle + offset
        if (Math.abs(angleDifference(angle, unconstrained.fit.angle)) > Math.PI / 4
          || coarseAngle !== null && Math.abs(angleDifference(angle, coarseAngle)) > Math.PI / 3) continue
        const distance = [0.1, 0.5, 0.9].reduce((sum, t) =>
          sum + nearest(apply(interpolate(axisEdge.start, axisEdge.end, t), unconstrained.fit), [edge]).distance, 0)
        locked.push({ angle, edge, distance })
      }
    }
    locked.sort((a, b) => a.distance - b.distance)
    if (!locked.length) throw new Error('PDF 垂直/水平边找不到邻近 OSM 长边的平行方向')
  }
  const feasible: { fit: Similarity; cost: number }[] = axisEdge ? [] : candidates.filter(candidate =>
    candidate.fit.scale >= minimumScale && candidate.fit.scale <= maximumScale && isContained(candidate.fit),
  )
  for (const match of locked.slice(0, 4)) {
    let fit = { ...unconstrained.fit, angle: match.angle }
    for (let i = 0; i < 100; i++) {
      const transformed = source.map(edge => ({ start: apply(edge.start, fit), end: apply(edge.end, fit) }))
      const pairs = sourceSamples.map((point, j) => ({
        source: point, target: nearest(apply(point, fit), target).point, weight: axial[sourceIndices[j]] ? 4 : 1,
      }))
      for (const point of targetSamples) {
        const closest = nearest(point, transformed), edge = source[closest.segment]
        pairs.push({ source: interpolate(edge.start, edge.end, closest.fraction), target: point, weight: axial[closest.segment] ? 4 : 1 })
      }
      const next = similarity(pairs.map(pair => pair.source), pairs.map(pair => pair.target), pairs.map(pair => pair.weight), match.angle)
      const movement = Math.hypot(next.translation.x - fit.translation.x, next.translation.y - fit.translation.y) + Math.abs(next.scale - fit.scale)
      fit = next
      if (movement < 1e-10) break
    }
    candidates.push({ fit, cost: score(fit) })
    if (fit.scale >= minimumScale && fit.scale <= maximumScale && isContained(fit)) feasible.push({ fit, cost: score(fit) })
  }
  candidates.sort((a, b) => a.cost - b.cost)
  const fitAt = (angle: number, center: Point): Similarity | null => {
    const rotated = sourceRing.map(point => apply(point, { angle, scale: 1, translation: { x: 0, y: 0 } }))
    const width = Math.max(...rotated.map(p => p.x)) - Math.min(...rotated.map(p => p.x))
    const height = Math.max(...rotated.map(p => p.y)) - Math.min(...rotated.map(p => p.y))
    const upper = Math.min(maximumScale, (bounds.maxX - bounds.minX) / width, (bounds.maxY - bounds.minY) / height)
    if (upper < minimumScale) return null
    const atScale = (scale: number): Similarity => {
      const initial = { angle, scale, translation: { x: 0, y: 0 } }
      return { ...initial, translation: subtract(center, apply(s, initial)) }
    }
    let outside = upper
    // Descending brackets do not assume monotonic containment in a concave union.
    for (let i = 0; i <= 20; i++) {
      const scale = upper - (upper - minimumScale) * i / 20, fit = atScale(scale)
      if (!isContained(fit)) { outside = scale; continue }
      let lower = scale, higher = outside
      for (let step = 0; step < 28; step++) {
        const middle = (lower + higher) / 2
        if (isContained(atScale(middle))) lower = middle
        else higher = middle
      }
      return atScale(lower)
    }
    return null
  }
  const angles: number[] = []
  for (const candidate of axisEdge ? locked.slice(0, 4).map(match => ({ fit: { ...unconstrained.fit, angle: match.angle } })) : candidates) {
    if (!angles.some(angle => Math.abs(angleDifference(angle, candidate.fit.angle)) < Math.PI / 360)) angles.push(candidate.fit.angle)
    if (angles.length >= 8) break
  }
  const centers = [...codeCenters, t]
  for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
    const point = { x: bounds.minX + (x + 0.5) / 7 * (bounds.maxX - bounds.minX), y: bounds.minY + (y + 0.5) / 7 * (bounds.maxY - bounds.minY) }
    if (inPolygons(point, polygons)) centers.push(point)
  }
  if (!feasible.some(candidate => candidate.cost < 1e-12)) {
    for (const angle of angles) {
      for (const center of [...centers, ...candidates.slice(0, 4).map(candidate => apply(s, candidate.fit))]) {
        const fit = fitAt(angle, center)
        if (fit) feasible.push({ fit, cost: score(fit) })
      }
    }
  }
  if (!feasible.length) throw new Error('无法在整体 Hall 凹形套索内找到支持缩放范围的完整包含配准')
  feasible.sort((a, b) => a.cost - b.cost)
  for (const seed of feasible.slice(0, 3)) {
    let best = seed
    for (let level = 0; level < 7 && best.cost > 1e-12; level++) {
      const shift = diagonal * 0.03 / 2 ** level, turn = Math.PI / 90 / 2 ** level
      for (let iteration = 0; iteration < 6; iteration++) {
        const center = apply(s, best.fit), previous = best
        const moves = [[shift, 0, 0], [-shift, 0, 0], [0, shift, 0], [0, -shift, 0]]
        if (!axisEdge) moves.push([0, 0, turn], [0, 0, -turn])
        for (const [dx, dy, da] of moves) {
          const angle = previous.fit.angle + da
          if (coarseAngle !== null && Math.abs(angleDifference(angle, coarseAngle)) > Math.PI / 3) continue
          const fit = fitAt(angle, { x: center.x + dx, y: center.y + dy })
          if (!fit) continue
          const cost = score(fit)
          if (cost < best.cost - 1e-9) best = { fit, cost }
        }
        if (best === previous) break
      }
    }
    feasible.push(best)
  }
  feasible.sort((a, b) => a.cost - b.cost)
  const fit = feasible[0].fit
  if (!isContained(fit)) throw new Error('Hall 完整包含校验失败')
  const transformed = source.map(edge => ({ start: apply(edge.start, fit), end: apply(edge.end, fit) }))
  const distances = sourceSamples.map(point => nearest(apply(point, fit), target).distance)
  const axisDistances = distances.filter((_, i) => axial[sourceIndices[i]])
  const matched = locked.find(match => Math.abs(angleDifference(match.angle, fit.angle)) < 1e-8)
  const alignment = axisEdge && matched ? {
    source: { start: apply(axisEdge.start, fit), end: apply(axisEdge.end, fit) }, target: matched.edge,
    angleErrorDegrees: Math.abs(Math.asin(Math.max(-1, Math.min(1,
      cross(subtract(apply(axisEdge.end, fit), apply(axisEdge.start, fit)), subtract(matched.edge.end, matched.edge.start))
      / (Math.hypot(axisEdge.end.x - axisEdge.start.x, axisEdge.end.y - axisEdge.start.y) * fit.scale
        * Math.hypot(matched.edge.end.x - matched.edge.start.x, matched.edge.end.y - matched.edge.start.y)),
    )))) * 180 / Math.PI,
  } : null
  if (axisEdge && (!alignment || alignment.angleErrorDegrees > 1e-6)) throw new Error('PDF 垂直/水平边平行对齐校验失败')
  return {
    fit,
    alignment,
    error: (distances.reduce((sum, distance) => sum + distance, 0)
      + targetSamples.reduce((sum, point) => sum + nearest(point, transformed).distance, 0)) / (sourceSamples.length + targetSamples.length),
    axisError: axisDistances.length ? axisDistances.reduce((sum, distance) => sum + distance, 0) / axisDistances.length : null,
  }
}

export function registerHall(hall: MapHall, placement: HallPlacement, map: OsmMapData): {
  placement: HallPlacement; report: HallRegistrationReport
} {
  const labels = new Map<string, Point[]>()
  for (const label of hall.labels) {
    if (label.code === null) continue
    const positions = labels.get(label.code) ?? []
    positions.push({
      x: (label.center.x - hall.pivot.x) * placement.aspectRatio,
      y: label.center.y - hall.pivot.y,
    })
    labels.set(label.code, positions)
  }
  if (!labels.size) throw new Error('识别数据中没有有效的子馆标签')
  const codes = [...labels.keys()]
  const features = map.features.filter(feature =>
    feature.area && !feature.polygonMember && hallCodes(feature.tags).some(code => labels.has(code)),
  )
  for (const code of codes) {
    if (!features.some(feature => hallCodes(feature.tags).includes(code))) throw new Error(`OSM 缺少子馆 ${code} 的有效闭合图形`)
  }
  const origin = features[0].paths[0][0]
  const rings = features.map(feature => ({ feature, rings: featureRings(feature, origin) }))
  const subhallPolygons = rings.map(item => item.rings)
  const envelope = hallEnvelope(subhallPolygons)
  const polygons = [[envelope]], target = ringSegments(envelope)
  const alignmentTargets = hallUnionBoundary(subhallPolygons.flat(1), subhallPolygons).filter(edge =>
    nearest(interpolate(edge.start, edge.end, 0.5), target).distance < 1e-10,
  )
  const source = ringSegments(hall.page.hallOutline?.polygon.map(point => ({
    x: (point.x - hall.pivot.x) * placement.aspectRatio, y: point.y - hall.pivot.y,
  })) ?? [])
  if (source.length < 3) throw new Error('识别数据中没有有效的 Hall 框线')
  const codeCenters = codes.map(code => {
    const subhall = rings.filter(item => hallCodes(item.feature.tags).includes(code)).map(item => item.rings)
    return areaCenter(hallUnionBoundary(subhall.flat(1), subhall))
  })
  const coarseAngle = codes.length > 1 ? similarity([...labels.values()].map(mean), codeCenters).angle : null
  const anchor = projectCoordinate(placement.anchor.latitude, placement.anchor.longitude)
  const meters = Math.cos(placement.anchor.latitude * Math.PI / 180)
  const boothGeometry = hall.page.booths.map(({ bbox }) => [
      { x: bbox.x, y: bbox.y }, { x: bbox.x + bbox.width, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y + bbox.height }, { x: bbox.x, y: bbox.y + bbox.height },
    ].map(point => ({ x: (point.x - hall.pivot.x) * placement.aspectRatio, y: point.y - hall.pivot.y })))
  const sourceContains = containmentChecker([[source.map(edge => edge.start)]], source)
  const extraGeometry = boothGeometry.filter(ring => !sourceContains(ring))
  const { fit, error, axisError, alignment } = fitBoundary(source, target, polygons, coarseAngle, 0.001 / meters, 10 / meters, codeCenters, alignmentTargets, extraGeometry)
  const contained = containmentChecker(polygons, target)
  for (const corners of boothGeometry) {
    if (!contained(corners.map(point => apply(point, fit)))) throw new Error('Booth 超出整体 Hall 凹形套索，完整包含校验失败')
  }
  const targetPoints = target.flatMap(segment => [segment.start, segment.end])
  const diagonal = Math.hypot(
    Math.max(...targetPoints.map(p => p.x)) - Math.min(...targetPoints.map(p => p.x)),
    Math.max(...targetPoints.map(p => p.y)) - Math.min(...targetPoints.map(p => p.y)),
  )
  return {
    placement: {
      ...placement, rotation: angleDifference(fit.angle, 0) * 180 / Math.PI, scale: fit.scale * meters,
      offset: {
        x: (origin.x + fit.translation.x - anchor.x) * meters,
        y: (origin.y + fit.translation.y - anchor.y) * meters,
      },
    },
    report: {
      hallIndex: hall.index, name: hall.name, codes, orientation: coarseAngle === null ? 'boundary' : 'markers',
      rmsErrorMeters: Math.sqrt(error) * meters, relativeError: Math.sqrt(error) / diagonal,
      axisRmsErrorMeters: axisError === null ? null : Math.sqrt(axisError) * meters, contained: true,
      envelope: envelope.map(point => ({ x: point.x + origin.x, y: point.y + origin.y })),
      alignment: alignment ? {
        ...alignment,
        source: {
          start: { x: alignment.source.start.x + origin.x, y: alignment.source.start.y + origin.y },
          end: { x: alignment.source.end.x + origin.x, y: alignment.source.end.y + origin.y },
        },
        target: {
          start: { x: alignment.target.start.x + origin.x, y: alignment.target.start.y + origin.y },
          end: { x: alignment.target.end.x + origin.x, y: alignment.target.end.y + origin.y },
        },
      } : null,
    },
  }
}
