export interface PreviewHallOutline {
  method: 'closed_frame' | 'layout_notch' | 'nonwhite_bbox'
  polygon: { x: number; y: number }[]
  bbox: { x: number; y: number; width: number; height: number }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseHallOutline(value: unknown, width: number, height: number): PreviewHallOutline | null {
  if (value === undefined) return null
  if (!record(value) || !Array.isArray(value.polygon) || value.polygon.length < 3 || !record(value.bbox)) {
    throw new Error('Hall 边框格式无效')
  }
  const { method } = value
  if (method !== 'closed_frame' && method !== 'layout_notch' && method !== 'nonwhite_bbox') {
    throw new Error('Hall 边框格式无效')
  }
  const polygon = value.polygon.map((point: unknown) => {
    if (!record(point) || typeof point.x !== 'number' || typeof point.y !== 'number'
      || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)
      || point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
      throw new Error('Hall 边框顶点超出原图或不是像素坐标')
    }
    return { x: point.x, y: point.y }
  })
  const minX = Math.min(...polygon.map(point => point.x))
  const minY = Math.min(...polygon.map(point => point.y))
  const maxX = Math.max(...polygon.map(point => point.x))
  const maxY = Math.max(...polygon.map(point => point.y))
  const bbox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  const sourceBox = value.bbox
  if (Object.entries(bbox).some(([key, number]) => sourceBox[key] !== number)) {
    throw new Error('Hall 边框包围框与顶点不一致')
  }
  if (method === 'nonwhite_bbox' && (polygon.length !== 4
    || polygon.some((point, index) => point.x !== [minX, maxX, maxX, minX][index]
      || point.y !== [minY, minY, maxY, maxY][index]))) {
    throw new Error('Hall 矩形边框顶点不一致')
  }
  return { method, polygon, bbox }
}