import type { PreviewBooth, PreviewPage } from './data'
import type { PathSegment } from './pathGraph'
import { inverseTransform, transformPoint } from './pdfPreview'

type Point = { x: number; y: number }
type Line = [Point, Point]
type Box = PreviewBooth['bbox']
type Axis = 'x' | 'y'
export type BoothFacing = { wall: boolean; direction: Point | null }

const center = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
const size = (b: Box, axis: Axis) => axis === 'x' ? b.width : b.height
const across = (axis: Axis): Axis => axis === 'x' ? 'y' : 'x'
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
const span = (b: Box, v: Point) => Math.abs(v.x) * b.width + Math.abs(v.y) * b.height

function wallRows(booths: PreviewBooth[], edges: Line[], layoutNotch: boolean,
  southCrop: boolean, axes: ReadonlyMap<string, Axis>) {
  const winding = Math.sign(edges.reduce((area, [a, b]) => area + a.x * b.y - a.y * b.x, 0))
  const concave = edges.map(([a, b], i) => {
    const [previous] = edges[(i + edges.length - 1) % edges.length]
    return ((a.x - previous.x) * (b.y - a.y) - (a.y - previous.y) * (b.x - a.x)) * winding < 0
  })
  const walls = edges.flatMap(([a, b], i) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (!length || !winding) return []
    const tangent = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
    // The simplified West recess outline is set back from the actual booth rows.
    const depthLimit = southCrop ? 3 : layoutNotch && (concave[i] || concave[(i + 1) % edges.length]) ? 5 : 1.5
    return [{ a, length, tangent, depthLimit, inward: { x: -tangent.y * winding, y: tangent.x * winding } }]
  })
  const islands = new Map<string, PreviewBooth[]>()
  for (const booth of booths) {
    if (!booth.islandId) continue
    const group = islands.get(booth.islandId) ?? []
    group.push(booth)
    islands.set(booth.islandId, group)
  }
  const result = new Map<string, Point>()
  for (const group of islands.values()) {
    const row = group.map(booth => {
      const p = center(booth.bbox)
      const axis = axes.get(booth.id)
      const candidates = walls.map(({ a, tangent, inward, length, depthLimit }, index) => {
        const offset = { x: p.x - a.x, y: p.y - a.y }
        const along = dot(offset, tangent), depth = span(booth.bbox, inward)
        const normal = dot(offset, inward)
        const distance = Math.hypot(normal, along - Math.max(0, Math.min(length, along)))
        return { index, distance, depth, along, width: span(booth.bbox, tangent), inward, depthLimit }
      }).sort((a, b) => a.distance - b.distance)
      const nearest = candidates.at(0)
      if (!nearest) return null
      // At South Hall corners the nearest crop edge may run parallel to the divider.
      const facing = southCrop && axis ? candidates.find(cell =>
        cell.distance <= cell.depth * cell.depthLimit && Math.abs(cell.inward[axis]) >= 0.1) : undefined
      return { ...nearest, facing: (facing ?? nearest).inward }
    })
    if (!row.every(cell => cell !== null)) continue
    if (row.some(cell => cell.distance > cell.depth * cell.depthLimit)) continue
    const singleDepth = row.every((cell, i) => row.slice(0, i).every(other =>
      cell.index !== other.index || Math.abs(cell.distance - other.distance) <= Math.min(cell.depth, other.depth) / 2
      || (cell.width + other.width) / 2 - Math.abs(cell.along - other.along) <= Math.min(cell.width, other.width) / 4))
    if (singleDepth) group.forEach((booth, i) => result.set(booth.id, row[i].facing))
  }
  return result
}

function firstCrossing(lines: Line[], axis: Axis, start: number, along: number, sign: number) {
  const side = across(axis)
  let nearest = Infinity
  for (const [a, b] of lines) {
    if (along < Math.min(a[side], b[side]) || along > Math.max(a[side], b[side])) continue
    if (a[side] === b[side]) {
      const near = Math.min(sign * (a[axis] - start), sign * (b[axis] - start))
      const far = Math.max(sign * (a[axis] - start), sign * (b[axis] - start))
      if (far > 0) nearest = Math.min(nearest, Math.max(0, near))
      continue
    }
    const point = a[axis] + (b[axis] - a[axis]) * (along - a[side]) / (b[side] - a[side])
    const distance = (point - start) * sign
    if (distance > 0) nearest = Math.min(nearest, distance)
  }
  return nearest
}

function facesAisle(booth: PreviewBooth, neighbors: PreviewBooth[], axis: Axis, sign: number, paths: Line[], walls: Line[]) {
  const side = across(axis), box = booth.bbox
  const depth = size(box, axis), width = size(box, side)
  const start = box[axis] + (sign > 0 ? depth : 0)
  const ahead = neighbors.flatMap(other => {
    if (other === booth) return []
    const b = other.bbox
    const overlap = Math.min(box[side] + width, b[side] + size(b, side)) - Math.max(box[side], b[side])
    const gap = sign * (b[axis] + (sign < 0 ? size(b, axis) : 0) - start)
    return overlap > 0 && gap >= -2 && gap < 4 * depth ? [{ b, overlap, gap }] : []
  })
  if (ahead.some(({ overlap, gap }) => overlap >= width / 4 && gap <= Math.max(3, depth * 0.12))) return false
  return [0.25, 0.5, 0.75].some(fraction => {
    const along = box[side] + fraction * width
    const distance = firstCrossing(paths, axis, start, along, sign)
    return distance <= 4 * depth && distance < firstCrossing(walls, axis, start, along, sign)
      && !ahead.some(({ b, gap }) => gap <= distance && along >= b[side] && along <= b[side] + size(b, side))
  })
}

export function inferBoothFacings(
  page: Pick<PreviewPage, 'booths' | 'halfBooths' | 'hallOutline' | 'pdfPreview' | 'venue'>, pdfPaths: PathSegment[],
): Map<string, BoothFacing> {
  const inverse = page.pdfPreview && inverseTransform(page.pdfPreview.transform)
  return inferBoothFacingsFromPaths(page, inverse ? pdfPaths.map(([x, y, u, v]) => [
    transformPoint(inverse, x, y), transformPoint(inverse, u, v),
  ]) : [])
}

export function inferBoothFacingsFromPaths(
  page: Pick<PreviewPage, 'booths' | 'halfBooths' | 'hallOutline' | 'venue'>, paths: Line[],
): Map<string, BoothFacing> {
  const polygon = page.hallOutline?.polygon ?? []
  const walls: Line[] = polygon.map((point, i) => [point, polygon[(i + 1) % polygon.length]])
  const halves = new Map(page.halfBooths?.map(half => [half.boothId, half.bbox]))
  const axes = new Map<string, Axis>()
  for (const booth of page.booths) {
    const half = halves.get(booth.id)
    if (half) axes.set(booth.id, half.width < booth.bbox.width ? 'y' : 'x')
  }
  const southCrop = page.hallOutline?.method === 'nonwhite_bbox' && page.venue?.label === '\u535712'
  const inward = wallRows(page.booths, walls, page.hallOutline?.method === 'layout_notch', southCrop, axes)
  const result = new Map<string, BoothFacing>()
  for (const booth of page.booths) {
    const axis = axes.get(booth.id), normal = inward.get(booth.id)
    let direction: Point | null = null
    if (axis) {
      let sign = 0
      if (normal) {
        if (Math.abs(normal[axis]) >= 0.1) sign = Math.sign(normal[axis])
      } else {
        const positive = facesAisle(booth, page.booths, axis, 1, paths, walls)
        const negative = facesAisle(booth, page.booths, axis, -1, paths, walls)
        sign = Number(positive) - Number(negative)
      }
      if (sign) direction = axis === 'x' ? { x: sign, y: 0 } : { x: 0, y: sign }
    }
    result.set(booth.id, { wall: !!normal, direction })
  }
  return result
}
