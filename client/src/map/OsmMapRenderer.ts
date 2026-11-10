import type { OsmFeature, OsmMapData } from './osm'
import { fitViewport, panViewport, screenToWorld, worldToScreen, zoomViewport } from './viewport'
import type { Point, Size, Viewport } from './viewport'
import { compareMapStyles, gridColor, mapBackground, mapStyle, onewayTriangles } from './style'
import type { MapStyle } from './style'

interface StyledFeature {
  feature: OsmFeature
  path: Path2D
  arrows: Path2D
  style: MapStyle
}

function localPath(paths: Point[][], origin: Point, closed: boolean): Path2D {
  const path = new Path2D()
  for (const points of paths) {
    if (!points.length) continue
    // Local coordinates preserve sub-meter Path2D precision at high zoom.
    path.moveTo(points[0].x - origin.x, points[0].y - origin.y)
    for (const point of points.slice(1)) path.lineTo(point.x - origin.x, point.y - origin.y)
    if (closed) path.closePath()
  }
  return path
}

export class OsmMapRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly data: OsmMapData
  private readonly onZoom: (percent: number) => void
  private readonly origin: Point
  private readonly metersPerUnit: number
  private readonly context: CanvasRenderingContext2D
  private readonly features: StyledFeature[]
  private size: Size = { width: 1, height: 1 }
  private view: Viewport | null = null
  private pixelRatio = 1
  private frame: number | null = null

  constructor(
    canvas: HTMLCanvasElement,
    data: OsmMapData,
    onZoom: (percent: number) => void,
  ) {
    this.canvas = canvas
    this.data = data
    this.onZoom = onZoom
    this.origin = {
      x: (data.bounds.minX + data.bounds.maxX) / 2,
      y: (data.bounds.minY + data.bounds.maxY) / 2,
    }
    // Match the reference's ground-meter styles without changing Mercator geometry.
    this.metersPerUnit = 1 / Math.cosh(this.origin.y / 6378137)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建 Canvas 2D 上下文')
    this.context = context
    this.features = data.features.map(feature => ({
      feature,
      path: localPath(feature.paths, this.origin, feature.area),
      arrows: localPath(onewayTriangles(feature.paths, feature.tags, this.metersPerUnit), this.origin, true),
      style: mapStyle(feature),
    })).sort((a, b) => compareMapStyles(a.style, b.style))
  }

  resize(width: number, height: number, pixelRatio: number) {
    if (width <= 0 || height <= 0) return
    this.size = { width, height }
    this.pixelRatio = Math.max(1, pixelRatio)
    this.canvas.width = Math.round(width * this.pixelRatio)
    this.canvas.height = Math.round(height * this.pixelRatio)
    if (!this.view) this.view = fitViewport(this.data.bounds, this.size)
    this.requestDraw()
  }

  fit() {
    this.view = fitViewport(this.data.bounds, this.size)
    this.requestDraw()
  }

  pan(dx: number, dy: number) {
    if (!this.view) return
    this.view = panViewport(this.view, dx, dy)
    this.requestDraw()
  }

  zoom(factor: number, anchor: Point = { x: this.size.width / 2, y: this.size.height / 2 }) {
    if (!this.view) return
    const fitScale = fitViewport(this.data.bounds, this.size).scale
    this.view = zoomViewport(this.view, factor, anchor, this.size, fitScale / 4, fitScale * 256)
    this.requestDraw()
  }

  private requestDraw() {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.draw()
    })
  }

  private draw() {
    if (!this.view) return
    const { context: ctx, size, view, pixelRatio: dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = mapBackground
    ctx.fillRect(0, 0, size.width, size.height)
    const margin = 100 * view.scale / this.metersPerUnit
    const topLeft = screenToWorld({ x: -margin, y: -margin }, view, size)
    const bottomRight = screenToWorld({ x: size.width + margin, y: size.height + margin }, view, size)
    ctx.setTransform(
      dpr * view.scale, 0, 0, dpr * view.scale,
      dpr * (size.width / 2 - (view.center.x - this.origin.x) * view.scale),
      dpr * (size.height / 2 - (view.center.y - this.origin.y) * view.scale),
    )
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    this.drawGrid()
    const visible: StyledFeature[] = []
    for (const item of this.features) {
      const { feature, path, style } = item
      const b = feature.bounds
      if (b.maxX < topLeft.x || b.minX > bottomRight.x || b.maxY < topLeft.y || b.minY > bottomRight.y) continue
      visible.push(item)
      if (style.fill && feature.area) {
        ctx.fillStyle = style.fill
        ctx.fill(path, 'evenodd')
      }
      if (style.stroke) {
        ctx.setLineDash(style.lineDash.map(length => length / this.metersPerUnit))
        ctx.strokeStyle = style.stroke
        ctx.lineWidth = style.strokeWidth / this.metersPerUnit
        ctx.stroke(path)
      }
    }
    ctx.setLineDash([])
    for (const item of visible) {
      ctx.fillStyle = item.style.stroke ?? 'rgba(41, 65, 73, 0.78)'
      ctx.fill(item.arrows)
    }
    this.drawLabels(visible)
    this.onZoom(Math.round(view.scale / fitViewport(this.data.bounds, size).scale * 100))
  }

  private drawGrid() {
    if (!this.view) return
    const { context: ctx, size, view, origin } = this
    const first = screenToWorld({ x: 0, y: 0 }, view, size)
    const last = screenToWorld({ x: size.width, y: size.height }, view, size)
    const step = 100 / this.metersPerUnit
    ctx.strokeStyle = gridColor
    ctx.lineWidth = Math.max(0.5 / view.scale, 0.02 / this.metersPerUnit)
    ctx.setLineDash([])
    ctx.beginPath()
    for (let x = Math.floor((first.x - origin.x) / step) * step; x <= last.x - origin.x; x += step) {
      ctx.moveTo(x, first.y - origin.y)
      ctx.lineTo(x, last.y - origin.y)
    }
    for (let y = Math.floor((first.y - origin.y) / step) * step; y <= last.y - origin.y; y += step) {
      ctx.moveTo(first.x - origin.x, y)
      ctx.lineTo(last.x - origin.x, y)
    }
    ctx.stroke()
  }

  private drawLabels(features: StyledFeature[]) {
    if (!this.view) return
    const ctx = this.context
    const view = this.view
    const groundZoom = view.scale / this.metersPerUnit
    const fontSize = Math.max(13, 11 * groundZoom)
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
    ctx.setLineDash([])
    ctx.font = `${fontSize}px "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const occupied: { x: number; y: number; width: number }[] = []
    for (const { feature, style } of [...features].reverse()) {
      if (!style.hallLabel) continue
      const b = feature.bounds
      const p = worldToScreen({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, view, this.size)
      const width = ctx.measureText(style.hallLabel.text).width + 10
      if (p.x + width / 2 < 0 || p.y + fontSize / 2 < 0
        || p.x - width / 2 > this.size.width || p.y - fontSize / 2 > this.size.height) continue
      if (occupied.some(other => Math.abs(p.x - other.x) < (width + other.width) / 2
        && Math.abs(p.y - other.y) < fontSize + 4)) continue
      occupied.push({ ...p, width })
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)'
      ctx.lineWidth = Math.max(2.6, groundZoom)
      ctx.strokeText(style.hallLabel.text, p.x, p.y)
      ctx.fillStyle = style.hallLabel.color
      ctx.fillText(style.hallLabel.text, p.x, p.y)
    }
  }

  dispose() {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }
}
