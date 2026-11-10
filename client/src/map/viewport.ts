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
}

export interface Size {
  width: number
  height: number
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

export function fitViewport(bounds: Bounds, size: Size): Viewport {
  return {
    center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    scale: Math.min(
      Math.max(1, size.width - 64) / Math.max(1, bounds.maxX - bounds.minX),
      Math.max(1, size.height - 64) / Math.max(1, bounds.maxY - bounds.minY),
    ),
  }
}

export function screenToWorld(point: Point, view: Viewport, size: Size): Point {
  return {
    x: view.center.x + (point.x - size.width / 2) / view.scale,
    y: view.center.y + (point.y - size.height / 2) / view.scale,
  }
}

export function worldToScreen(point: Point, view: Viewport, size: Size): Point {
  return {
    x: (point.x - view.center.x) * view.scale + size.width / 2,
    y: (point.y - view.center.y) * view.scale + size.height / 2,
  }
}

export function panViewport(view: Viewport, dx: number, dy: number): Viewport {
  return {
    ...view,
    center: { x: view.center.x - dx / view.scale, y: view.center.y - dy / view.scale },
  }
}

export function zoomViewport(
  view: Viewport, factor: number, anchor: Point, size: Size, minimum: number, maximum: number,
): Viewport {
  const scale = Math.max(minimum, Math.min(maximum, view.scale * factor))
  const world = screenToWorld(anchor, view, size)
  return {
    scale,
    center: {
      x: world.x - (anchor.x - size.width / 2) / scale,
      y: world.y - (anchor.y - size.height / 2) / scale,
    },
  }
}
