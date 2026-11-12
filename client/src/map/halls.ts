import { blockGeometry } from '../preview/blockGeometry'
import type { PreviewBooth, PreviewBlock, PreviewPage, PreviewIslandMarker } from '../preview/data'
import type { PreviewHalfBooth } from '../preview/halfBooths'
import type { Bounds, Point } from './viewport'
import { projectCoordinate } from './viewport'

export interface HallPlacement {
  hallIndex: number
  name: string | null
  anchor: { latitude: number; longitude: number }
  offset: Point
  rotation: number
  scale: number
  aspectRatio: number
}

export interface HallTransforms {
  schemaVersion: 1
  placements: HallPlacement[]
}

export interface MapHall {
  index: number
  name: string | null
  page: PreviewPage
  pivot: Point
  bounds: Bounds
  labels: { id: string; text: string | null; code: string | null; center: Point }[]
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hall 数据对象无效')
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Hall 数据列表无效')
  return value
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Hall 数据坐标无效')
  return value
}

function text(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value) throw new Error('Hall 数据文字无效')
  return value
}

function identifier(value: unknown, used: Set<string>): string {
  const id = text(value)
  if (!id || used.has(id)) throw new Error('Hall 数据 ID 缺失或重复')
  used.add(id)
  return id
}

function point(value: unknown): Point {
  const p = object(value)
  const x = number(p.x), y = number(p.y)
  if (x < 0 || y < 0) throw new Error('Hall 原图坐标不能为负')
  return { x, y }
}

function box(value: unknown): PreviewBooth['bbox'] {
  const b = object(value), p = point(value)
  const width = number(b.width), height = number(b.height)
  if (width <= 0 || height <= 0) throw new Error('Hall 图格尺寸无效')
  return { ...p, width, height }
}

export function pointsBounds(points: Point[]): Bounds {
  if (!points.length) throw new Error('Hall 边界不能为空')
  return points.reduce((b, p) => ({
    minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y),
    maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
}

export function parseHalls(value: unknown): MapHall[] {
  const ids = new Set<string>()
  const halls = list(object(value).halls)
  if (!halls.length) throw new Error('final.json 没有 Hall')
  return halls.map((raw, index) => {
    const hall = object(raw), name = text(hall.name)
    const boundary = list(hall.boundary).map(point)
    if (boundary.length < 3) throw new Error('Hall 至少需要三个边界顶点')
    const bounds = pointsBounds(boundary)
    if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) throw new Error('Hall 边界尺寸无效')
    const booths: PreviewBooth[] = [], blocks: PreviewBlock[] = []
    const halves: PreviewHalfBooth[] = [], markers: PreviewIslandMarker[] = []
    for (const rawIsland of list(hall.islands)) {
      const island = object(rawIsland), islandId = identifier(island.id, ids), label = text(island.code)
      for (const rawMarker of list(island.markers)) {
        const marker = object(rawMarker)
        markers.push({
          id: identifier(marker.id, ids), bbox: null, center: point(marker.pos), label,
          color: '#8b35d1', status: label ? 'recognized' : 'unrecognized',
          recognitionScore: null, issues: [], inference: null,
        })
      }
      for (const rawBlock of list(island.blocks)) {
        const block = object(rawBlock), blockId = identifier(block.id, ids), bbox = box(block.bbox)
        const cells: PreviewBooth[] = []
        for (const rawBooth of list(block.booths)) {
          const booth = object(rawBooth), id = identifier(booth.id, ids), b = box(booth.bbox)
          const cell: PreviewBooth = {
            id, bbox: b, number: text(booth.number), rotation: b.height > b.width ? 270 : 0,
            status: booth.number === null ? 'unrecognized' : 'recognized',
            islandId, blockId, assignment: null,
          }
          if (b.x < bbox.x || b.y < bbox.y || b.x + b.width > bbox.x + bbox.width
            || b.y + b.height > bbox.y + bbox.height) throw new Error('Booth 超出 Block 范围')
          cells.push(cell)
          if (booth.split !== null) {
            const split = object(booth.split)
            if (!(['l', 'r', 't', 'b'].includes(String(split.a)))
              || !({ l: 'r', r: 'l', t: 'b', b: 't' }[String(split.a)] === split.b)) {
              throw new Error('Hall a/b 分割无效')
            }
            const horizontal = split.a === 'l' || split.a === 'r'
            const sides = horizontal ? ['l', 'r'] : ['t', 'b']
            sides.forEach((side, i) => halves.push({
              id: `${id}-h${i + 1}`, boothId: id, suffix: split.a === side ? 'a' : 'b',
              bbox: {
                x: b.x + (horizontal ? i * b.width / 2 : 0),
                y: b.y + (horizontal ? 0 : i * b.height / 2),
                width: horizontal ? b.width / 2 : b.width, height: horizontal ? b.height : b.height / 2,
              }, status: 'resolved', issues: [],
            }))
          }
        }
        if (!cells.length) throw new Error('Hall Block 不能为空')
        let grid = null
        if (block.grid !== undefined) {
          const g = object(block.grid), rows = number(g.rows), columns = number(g.columns)
          if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1
            || rows * columns !== cells.length) throw new Error('Hall Block 矩阵无效')
          grid = { rows, columns }
        }
        blocks.push({ id: blockId, bbox, islandId, boothIds: cells.map(c => c.id), ...blockGeometry(cells, bbox, grid) })
        booths.push(...cells)
      }
    }
    const labels = hall.labels === undefined ? [] : list(hall.labels).map(rawLabel => {
      const label = object(rawLabel)
      const id = identifier(label.id, ids), center = point(label.pos)
      return { id, text: text(label.text), code: text(label.code), center }
    })
    const allPoints = [
      ...boundary, ...booths.flatMap(b => [{ x: b.bbox.x, y: b.bbox.y },
        { x: b.bbox.x + b.bbox.width, y: b.bbox.y + b.bbox.height }]),
      ...markers.map(m => m.center), ...labels.map(l => l.center),
    ]
    const extent = pointsBounds(allPoints)
    const page: PreviewPage = {
      page: index + 1, image: '', width: Math.ceil(extent.maxX + 1), height: Math.ceil(extent.maxY + 1),
      booths, blocks, islandMarkers: markers, islandInference: null, islandAssignment: null,
      venue: null, markerAlignment: null, halfBooths: halves,
      hallOutline: {
        method: 'closed_frame', polygon: boundary,
        bbox: { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX + 1, height: bounds.maxY - bounds.minY + 1 },
      },
    }
    if (labels.some(label => label.code !== null && !/^[EWSN][1-9][0-9]?$/.test(label.code))) {
      throw new Error('Hall 标签编号无效')
    }
    return {
      index, name, page, bounds: extent, labels,
      pivot: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    }
  })
}

export function parseHallTransforms(value: unknown, halls: MapHall[]): HallTransforms {
  const data = object(value)
  if (data.schemaVersion !== 1) throw new Error('Hall 变换配置版本无效')
  const used = new Set<number>()
  const placements = list(data.placements).map(raw => {
    const p = object(raw), hallIndex = number(p.hallIndex)
    const hall = halls.find(h => h.index === hallIndex)
    if (!hall || used.has(hallIndex) || hall.name !== p.name) throw new Error('Hall 变换配置与 final.json 不匹配')
    used.add(hallIndex)
    const anchor = object(p.anchor), offset = object(p.offset)
    const latitude = number(anchor.latitude), longitude = number(anchor.longitude)
    if (Math.abs(latitude) > 85 || Math.abs(longitude) > 180) throw new Error('Hall 定位经纬度无效')
    const scale = number(p.scale), rotation = number(p.rotation)
    const aspectRatio = p.aspectRatio === undefined ? 1 : number(p.aspectRatio)
    if (scale < 0.001 || scale > 10 || Math.abs(rotation) > 36000
      || aspectRatio < 0.01 || aspectRatio > 100) throw new Error('Hall 缩放、长宽比或旋转超出范围')
    return {
      hallIndex, name: hall.name, anchor: { latitude, longitude },
      offset: { x: number(offset.x), y: number(offset.y) }, scale, rotation, aspectRatio,
    }
  })
  if (used.size !== halls.length) throw new Error('Hall 变换配置缺少场馆')
  return { schemaVersion: 1, placements }
}

export function hallMatrix(hall: MapHall, placement: HallPlacement): [number, number, number, number, number, number] {
  const anchor = projectCoordinate(placement.anchor.latitude, placement.anchor.longitude)
  const metersPerUnit = Math.cos(placement.anchor.latitude * Math.PI / 180)
  const scale = placement.scale / metersPerUnit
  const angle = placement.rotation * Math.PI / 180
  const cosine = scale * Math.cos(angle), sine = scale * Math.sin(angle)
  const a = cosine * placement.aspectRatio, b = sine * placement.aspectRatio, c = -sine, d = cosine
  return [
    a, b, c, d,
    anchor.x + placement.offset.x / metersPerUnit - a * hall.pivot.x - c * hall.pivot.y,
    anchor.y + placement.offset.y / metersPerUnit - b * hall.pivot.x - d * hall.pivot.y,
  ]
}

export function hallWorldBounds(hall: MapHall, placement: HallPlacement): Bounds {
  const [a, b, c, d, e, f] = hallMatrix(hall, placement), bounds = hall.bounds
  return pointsBounds([
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ].map(p => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f })))
}
