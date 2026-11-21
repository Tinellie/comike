export interface Point {
  x: number
  y: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Viewport {
  center: Point
  scale: number
  rotation?: number
}

export interface Size {
  width: number
  height: number
}

export function pointInRing(point: Point, ring: readonly Point[]): boolean {
  let inside = false
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function projectCoordinate(latitude: number, longitude: number): Point {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error('OSM 经纬度无效')
  }
  const radians = Math.PI / 180
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * radians
  return {
    x: 6378137 * longitude * radians,
    y: -6378137 * Math.log(Math.tan(Math.PI / 4 + lat / 2)),
  }
}

export function rotatePoint(point: Point, degrees: number): Point {
  const angle = degrees * Math.PI / 180
  const cosine = Math.cos(angle), sine = Math.sin(angle)
  return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine }
}

export function fitViewport(bounds: Bounds, size: Size, rotation = 0): Viewport {
  const angle = rotation * Math.PI / 180
  const width = Math.max(1, bounds.maxX - bounds.minX), height = Math.max(1, bounds.maxY - bounds.minY)
  return {
    center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    rotation,
    scale: Math.min(
      Math.max(1, size.width - 64) / (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height),
      Math.max(1, size.height - 64) / (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height),
    ),
  }
}

export function screenToWorld(point: Point, view: Viewport, size: Size): Point {
  const offset = rotatePoint({ x: (point.x - size.width / 2) / view.scale,
    y: (point.y - size.height / 2) / view.scale }, -(view.rotation ?? 0))
  return {
    x: view.center.x + offset.x, y: view.center.y + offset.y,
  }
}

export function worldToScreen(point: Point, view: Viewport, size: Size): Point {
  const offset = rotatePoint({ x: (point.x - view.center.x) * view.scale,
    y: (point.y - view.center.y) * view.scale }, view.rotation ?? 0)
  return {
    x: offset.x + size.width / 2, y: offset.y + size.height / 2,
  }
}

export function panViewport(view: Viewport, dx: number, dy: number): Viewport {
  const offset = rotatePoint({ x: dx / view.scale, y: dy / view.scale }, -(view.rotation ?? 0))
  return {
    ...view,
    center: { x: view.center.x - offset.x, y: view.center.y - offset.y },
  }
}

export function zoomViewport(
  view: Viewport, factor: number, anchor: Point, size: Size, minimum: number, maximum: number,
): Viewport {
  const scale = Math.max(minimum, Math.min(maximum, view.scale * factor))
  const world = screenToWorld(anchor, view, size)
  const offset = rotatePoint({ x: (anchor.x - size.width / 2) / scale,
    y: (anchor.y - size.height / 2) / scale }, -(view.rotation ?? 0))
  return {
    ...view,
    scale,
    center: {
      x: world.x - offset.x, y: world.y - offset.y,
    },
  }

}

export function viewportBounds(view: Viewport, size: Size, margin = 0): Bounds {
  const corners = [
    { x: -margin, y: -margin }, { x: size.width + margin, y: -margin },
    { x: size.width + margin, y: size.height + margin }, { x: -margin, y: size.height + margin },
  ].map(point => screenToWorld(point, view, size))
  return {
    minX: Math.min(...corners.map(p => p.x)), minY: Math.min(...corners.map(p => p.y)),
    maxX: Math.max(...corners.map(p => p.x)), maxY: Math.max(...corners.map(p => p.y)),
  }
}

export function dragRotation(previous: Point, current: Point, center: Point): number {
  const from = { x: previous.x - center.x, y: previous.y - center.y }
  const to = { x: current.x - center.x, y: current.y - center.y }
  if (Math.hypot(from.x, from.y) < 8 || Math.hypot(to.x, to.y) < 8) return 0
  const degrees = (Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x)) * 180 / Math.PI
  return ((degrees + 540) % 360) - 180
}
