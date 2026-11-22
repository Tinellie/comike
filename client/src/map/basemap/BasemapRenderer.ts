import { tagValues } from '../osm'
import type { OsmFeature } from '../osm'
import { SatelliteImagery } from '../satelliteImagery'
import { fitViewport, mercatorWorldWidth, panViewport, viewportBounds, worldToScreen, zoomViewport } from '../viewport'
import type { Bounds, Point, Size, Viewport } from '../viewport'

export interface BasemapData {
  readonly bounds: Bounds
  readonly features: readonly OsmFeature[]
}

export interface FeatureStyle {
  level: number
  layer: number
  fill: string | null
  stroke: string | null
  strokeWidth: number
  lineDash: readonly number[]
}

export interface StyledFeature {
  feature: OsmFeature
  path: Path2D
  arrows: Path2D
  style: FeatureStyle
}

export interface BasemapFrame {
  context: CanvasRenderingContext2D
  view: Viewport
  size: Size
  pixelRatio: number
  overlaps(bounds: Bounds): boolean
}

export interface BasemapPass {
  levels?: Iterable<number>
  featureStyle?(item: StyledFeature): FeatureStyle | null
  showArrows?(item: StyledFeature): boolean
  label?(item: StyledFeature): { text: string; color: string } | null
  afterLevel?(level: number): void
  afterFeatures?(): void
}

export interface BasemapLayer {
  fitBounds?(): Bounds
  prepare?(frame: BasemapFrame): BasemapPass
  resize?(width: number, height: number): void
  pointer?(point: MapPointer | null): void
  click?(point: MapPointer): void
  keyDown?(event: KeyboardEvent): void
  dispose?(): void
}

export interface MapPointer {
  screen: Point
  client: Point
  dragging: boolean
}

export function localPath(paths: readonly Point[][], origin: Point, closed: boolean): Path2D {
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

function defaultStyle(feature: OsmFeature): FeatureStyle {
  const { tags, area, polygonMember } = feature
  const road = tagValues(tags, 'highway').length > 0
  const building = tagValues(tags, 'building').length > 0 || tagValues(tags, 'building:part').length > 0
  const water = tagValues(tags, 'natural').includes('water')
  return {
    level: 0, layer: road ? 2 : building ? 1 : 0, lineDash: [],
    fill: area && !polygonMember ? water ? '#aad3df' : building ? '#ded7cd' : '#e1e6db' : null,
    stroke: polygonMember && !road ? null : road ? '#a19788' : '#8b9297',
    strokeWidth: road ? 2 : 0.85,
  }
}

export interface BasemapStyle {
  feature?(feature: OsmFeature): FeatureStyle
  arrows?(feature: OsmFeature, metersPerUnit: number): Point[][]
}

export class BasemapRenderer {
  readonly origin: Point
  readonly metersPerUnit: number
  readonly features: readonly StyledFeature[]
  private readonly context: CanvasRenderingContext2D
  private readonly bounds: Bounds
  private frame: number | null = null
  private layer: BasemapLayer | undefined
  private imagery: SatelliteImagery | null = null
  private viewport: Viewport | null = null
  private userLocation: Point | null = null
  private dimensions: Size = { width: 1, height: 1 }
  private dpr = 1

  constructor(canvas: HTMLCanvasElement, data: BasemapData, style?: BasemapStyle) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建 Canvas 2D 上下文')
    this.context = context
    this.bounds = data.bounds
    this.origin = { x: (data.bounds.minX + data.bounds.maxX) / 2, y: (data.bounds.minY + data.bounds.maxY) / 2 }
    this.metersPerUnit = 1 / Math.cosh(this.origin.y * 2 * Math.PI / mercatorWorldWidth)
    this.features = data.features.map(feature => ({
      feature,
      path: localPath(feature.paths, this.origin, feature.area),
      arrows: localPath(style?.arrows?.(feature, this.metersPerUnit) ?? [], this.origin, true),
      style: (style?.feature ?? defaultStyle)(feature),
    })).sort((a, b) => a.style.level - b.style.level || a.style.layer - b.style.layer)
  }

  get view() { return this.viewport }
  get size() { return this.dimensions }
  get pixelRatio() { return this.dpr }
  get canvas() { return this.context.canvas }

  setLayer(layer: BasemapLayer | undefined) { this.layer = layer }

  resize(width: number, height: number, pixelRatio: number) {
    if (width <= 0 || height <= 0) return
    this.dimensions = { width, height }
    this.dpr = Math.max(1, pixelRatio)
    this.canvas.width = Math.round(width * this.dpr)
    this.canvas.height = Math.round(height * this.dpr)
    this.layer?.resize?.(this.canvas.width, this.canvas.height)
    if (!this.viewport) {
      this.fit()
      if (this.userLocation) this.centerOn(this.userLocation)
    } else this.requestDraw()
  }

  fit(bounds = this.layer?.fitBounds?.() ?? this.bounds) {
    this.viewport = fitViewport(bounds, this.size, this.view?.rotation ?? 0)
    this.requestDraw()
  }

  centerOn(center: Point) {
    if (!this.view) return
    this.viewport = { ...this.view, center }
    this.requestDraw()
  }

  setUserLocation(point: Point | null) {
    if (point === this.userLocation) return
    this.userLocation = point
    if (point) this.centerOn(point)
    else this.requestDraw()
  }

  setRotation(degrees: number) {
    if (!Number.isFinite(degrees)) throw new Error('地图旋转角度无效')
    const normalized = ((degrees + 180) % 360 + 360) % 360 - 180
    const rotation = normalized === -180 && degrees > 0 ? 180 : normalized
    if (this.view && rotation !== this.view.rotation) {
      this.viewport = { ...this.view, rotation }
      this.requestDraw()
    }
    return rotation
  }

  pan(dx: number, dy: number) {
    if (!this.view) return
    this.viewport = panViewport(this.view, dx, dy)
    this.requestDraw()
  }

  zoom(factor: number, anchor: Point = { x: this.size.width / 2, y: this.size.height / 2 }) {
    if (!this.view) return
    const fitScale = fitViewport(this.bounds, this.size).scale
    this.viewport = zoomViewport(this.view, factor, anchor, this.size, fitScale / 4, fitScale * 256)
    this.requestDraw()
  }

  setSatelliteVisible(visible: boolean, onError: (failed: boolean) => void) {
    if (visible === Boolean(this.imagery)) return
    this.imagery?.dispose()
    this.imagery = visible ? new SatelliteImagery(() => this.requestDraw(), onError) : null
    this.requestDraw()
  }

  retrySatellite() { this.imagery?.retry() }

  requestDraw() {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.draw()
    })
  }

  private draw() {
    const { context: ctx, size, view, pixelRatio } = this
    if (!view) return
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    ctx.fillStyle = '#f6f4ef'
    ctx.fillRect(0, 0, size.width, size.height)
    const angle = (view.rotation ?? 0) * Math.PI / 180
    const scale = pixelRatio * view.scale
    const a = scale * Math.cos(angle), b = scale * Math.sin(angle)
    const originScreen = worldToScreen(this.origin, view, size)
    ctx.setTransform(a, b, -b, a, pixelRatio * originScreen.x, pixelRatio * originScreen.y)
    ctx.lineCap = ctx.lineJoin = 'round'
    this.imagery?.draw(ctx, view, size, pixelRatio, this.origin)
    this.drawGrid(view)
    const bounds = viewportBounds(view, size, 100 * view.scale / this.metersPerUnit)
    const overlaps = (b: Bounds) => !(b.maxX < bounds.minX || b.minX > bounds.maxX
      || b.maxY < bounds.minY || b.minY > bounds.maxY)
    const pass = this.layer?.prepare?.({ context: ctx, view, size, pixelRatio, overlaps })
    const byLevel = new Map<number, StyledFeature[]>()
    for (const item of this.features) {
      if (!overlaps(item.feature.bounds)) continue
      const items = byLevel.get(item.style.level) ?? []
      items.push(item)
      byLevel.set(item.style.level, items)
    }
    const levels = [...new Set([...byLevel.keys(), ...(pass?.levels ?? [])])].sort((a, b) => a - b)
    for (const level of levels) {
      const items = byLevel.get(level) ?? []
      for (const item of items) {
        const { feature, path, arrows } = item
        const style = pass?.featureStyle ? pass.featureStyle(item) : item.style
        if (!style) continue
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
        if (pass?.showArrows?.(item) !== false) {
          ctx.fillStyle = style.stroke ?? 'rgba(41, 65, 73, 0.78)'
          ctx.fill(arrows)
        }
      }
      ctx.setLineDash([])
      this.drawLabels(items, view, pass?.label)
      ctx.save()
      pass?.afterLevel?.(level)
      ctx.restore()
    }
    ctx.save()
    pass?.afterFeatures?.()
    ctx.restore()
    if (this.userLocation) {
      const { x, y } = worldToScreen(this.userLocation, view, size)
      ctx.save()
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(x, y, 7, 0, 2 * Math.PI)
      ctx.fillStyle = '#1976d2'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()
    }
  }

  private drawGrid(view: Viewport) {
    const ctx = this.context
    const bounds = viewportBounds(view, this.size)
    const { x, y } = this.origin
    const baseStep = 100 / this.metersPerUnit
    // Keep the venue's 100 m grid, but avoid enumerating invisible lines on regional maps.
    const step = baseStep * Math.max(1, Math.ceil(8 / (baseStep * view.scale)))
    ctx.strokeStyle = 'rgba(80, 87, 90, 0.12)'
    ctx.lineWidth = Math.max(0.5 / view.scale, 0.02 / this.metersPerUnit)
    ctx.setLineDash([])
    ctx.beginPath()
    for (let i = Math.floor((bounds.minX - x) / step) * step; i <= bounds.maxX - x; i += step) {
      ctx.moveTo(i, bounds.minY - y)
      ctx.lineTo(i, bounds.maxY - y)
    }
    for (let i = Math.floor((bounds.minY - y) / step) * step; i <= bounds.maxY - y; i += step) {
      ctx.moveTo(bounds.minX - x, i)
      ctx.lineTo(bounds.maxX - x, i)
    }
    ctx.stroke()
  }

  private drawLabels(items: readonly StyledFeature[], view: Viewport, labelFor?: BasemapPass['label']) {
    if (!labelFor) return
    const { context: ctx, size, pixelRatio } = this
    const groundZoom = view.scale / this.metersPerUnit
    const fontSize = Math.max(13, 11 * groundZoom)
    ctx.save()
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    ctx.font = `${fontSize}px "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const occupied: { x: number; y: number; width: number }[] = []
    for (const item of [...items].reverse()) {
      const label = labelFor(item)
      if (!label) continue
      const b = item.feature.bounds
      const p = worldToScreen({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, view, size)
      const width = ctx.measureText(label.text).width + 10
      if (p.x + width / 2 < 0 || p.y + fontSize / 2 < 0
        || p.x - width / 2 > size.width || p.y - fontSize / 2 > size.height) continue
      if (occupied.some(other => Math.abs(p.x - other.x) < (width + other.width) / 2
        && Math.abs(p.y - other.y) < fontSize + 4)) continue
      occupied.push({ ...p, width })
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)'
      ctx.lineWidth = Math.max(2.6, groundZoom)
      ctx.strokeText(label.text, p.x, p.y)
      ctx.fillStyle = label.color
      ctx.fillText(label.text, p.x, p.y)
    }
    ctx.restore()
  }

  dispose() {
    this.imagery?.dispose()
    this.layer?.dispose?.()
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }
}
