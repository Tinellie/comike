import type { OsmFeature, OsmMapData } from './osm'
import { featureLevels } from './osm'
import { fitViewport, panViewport, rotatePoint, viewportBounds, worldToScreen, zoomViewport } from './viewport'
import type { Point, Size, Viewport } from './viewport'
import { compareMapStyles, filteredLevelStyle, gridColor, mapBackground, mapStyle, matchesLevels, onewayTriangles } from './style'
import type { MapStyle } from './style'
import { HallMapLayer, defaultHallDisplay, hallMetadata } from './HallMapLayer'
import type { HallDisplay } from './HallMapLayer'
import { hallWorldBounds } from './halls'
import type { HallTransforms, MapHall } from './halls'
import type { Bounds } from './viewport'
import type { HallRegistrationReport } from './hallRegistration'

interface StyledFeature {
  feature: OsmFeature
  path: Path2D
  arrows: Path2D
  style: MapStyle
  levels: number[]
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
  private readonly onRotation: (degrees: number) => void
  private readonly origin: Point
  private readonly metersPerUnit: number
  private readonly context: CanvasRenderingContext2D
  private readonly features: StyledFeature[]
  private size: Size = { width: 1, height: 1 }
  private view: Viewport | null = null
  private pixelRatio = 1
  private frame: number | null = null
  private halls: MapHall[] = []
  private transforms: HallTransforms = { schemaVersion: 1, placements: [] }
  private hallDisplay: HallDisplay = defaultHallDisplay
  private selectedHall: number | null = null
  private registrationReports: HallRegistrationReport[] = []
  private readonly hallLayer = new HallMapLayer()
  private selectedLevels = new Set<number>()

  constructor(
    canvas: HTMLCanvasElement,
    data: OsmMapData,
    onZoom: (percent: number) => void,
    onRotation: (degrees: number) => void = () => {},
  ) {
    this.canvas = canvas
    this.data = data
    this.onZoom = onZoom
    this.onRotation = onRotation
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
      levels: featureLevels(feature.tags),
    })).sort((a, b) => compareMapStyles(a.style, b.style))
  }

  resize(width: number, height: number, pixelRatio: number) {
    if (width <= 0 || height <= 0) return
    this.size = { width, height }
    this.pixelRatio = Math.max(1, pixelRatio)
    this.canvas.width = Math.round(width * this.pixelRatio)
    this.canvas.height = Math.round(height * this.pixelRatio)
    if (!this.view) this.view = fitViewport(this.sceneBounds(), this.size)
    this.requestDraw()
  }

  fit() {
    this.view = fitViewport(this.sceneBounds(), this.size, this.view?.rotation ?? 0)
    this.requestDraw()
  }

  setHalls(halls: MapHall[], transforms: HallTransforms, display: HallDisplay, selected: number | null) {
    this.halls = halls
    this.transforms = transforms
    this.hallDisplay = display
    this.selectedHall = selected
    this.requestDraw()
  }

  fitHall(index: number) {
    const hall = this.halls.find(h => h.index === index)
    const placement = this.transforms.placements.find(p => p.hallIndex === index)
    if (!hall || !placement) throw new Error('找不到 Hall 定位数据')
    this.view = fitViewport(hallWorldBounds(hall, placement), this.size, this.view?.rotation ?? 0)
    this.requestDraw()
  }

  setRegistrationReports(reports: HallRegistrationReport[]) {
    this.registrationReports = reports
    this.requestDraw()
  }

  setRotation(degrees: number) {
    if (!Number.isFinite(degrees)) throw new Error('地图旋转角度无效')
    if (!this.view) return
    const normalized = ((degrees + 180) % 360 + 360) % 360 - 180
    const rotation = normalized === -180 && degrees > 0 ? 180 : normalized
    this.view = { ...this.view, rotation }
    this.onRotation(rotation)
    this.requestDraw()
  }

  rotate(degrees: number) {
    if (this.view) this.setRotation((this.view.rotation ?? 0) + degrees)
  }

  setLevels(levels: number[]) {
    this.selectedLevels = new Set(levels)
    this.requestDraw()
  }

  private sceneBounds(): Bounds {
    const bounds = { ...this.data.bounds }
    if (this.hallDisplay.visible) {
      for (const placement of this.transforms.placements) {
        const hall = this.halls.find(h => h.index === placement.hallIndex)
        if (!hall) continue
        const b = hallWorldBounds(hall, placement)
        bounds.minX = Math.min(bounds.minX, b.minX)
        bounds.minY = Math.min(bounds.minY, b.minY)
        bounds.maxX = Math.max(bounds.maxX, b.maxX)
        bounds.maxY = Math.max(bounds.maxY, b.maxY)
      }
    }
    return bounds
  }

  hallDragOffset(index: number, dx: number, dy: number, startOffset?: Point): Point {
    const placement = this.transforms.placements.find(p => p.hallIndex === index)
    if (!placement || !this.view) throw new Error('Hall 视口未就绪')
    const metersPerUnit = Math.cos(placement.anchor.latitude * Math.PI / 180)
    const offset = startOffset ?? placement.offset
    const delta = rotatePoint({ x: dx / this.view.scale, y: dy / this.view.scale }, -(this.view.rotation ?? 0))
    return {
      x: offset.x + delta.x * metersPerUnit,
      y: offset.y + delta.y * metersPerUnit,
    }
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
    const visibleBounds = viewportBounds(view, size, margin)
    const angle = (view.rotation ?? 0) * Math.PI / 180
    const cosine = Math.cos(angle), sine = Math.sin(angle)
    const originScreen = worldToScreen(this.origin, view, size)
    ctx.setTransform(
      dpr * view.scale * cosine, dpr * view.scale * sine,
      -dpr * view.scale * sine, dpr * view.scale * cosine,
      dpr * originScreen.x, dpr * originScreen.y,
    )
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    this.drawGrid()
    const overlaps = (b: Bounds) => !(b.maxX < visibleBounds.minX || b.minX > visibleBounds.maxX
      || b.maxY < visibleBounds.minY || b.minY > visibleBounds.maxY)
    const visible = this.features.filter(item => overlaps(item.feature.bounds)).map(item => {
      const filtered = !matchesLevels(item.levels, this.selectedLevels)
      return { ...item, filtered, style: filtered ? filteredLevelStyle(item.style) : item.style }
    })
    const hallItems = this.transforms.placements.flatMap(placement => {
      const hall = this.halls.find(h => h.index === placement.hallIndex)
      if (!hall || !overlaps(hallWorldBounds(hall, placement))) return []
      const level = hallMetadata(hall).level
      return [{ hall, placement, level, filtered: !matchesLevels([level], this.selectedLevels) }]
    })
    const levels = [...new Set([...visible.map(item => item.style.level), ...hallItems.map(item => item.level)])]
      .sort((a, b) => a - b)
    for (const level of levels) {
      const items = visible.filter(item => item.style.level === level)
      for (const { feature, path, style, arrows, filtered } of items) {
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
        if (!filtered) {
          ctx.fillStyle = style.stroke ?? 'rgba(41, 65, 73, 0.78)'
          ctx.fill(arrows)
        }
      }
      ctx.setLineDash([])
      ctx.save()
      this.drawLabels(items)
      ctx.restore()
      for (const { hall, placement, filtered } of hallItems.filter(item => item.level === level)) {
        this.hallLayer.draw(ctx, hall, placement, this.origin, this.hallDisplay,
          hall.index === this.selectedHall, view.rotation ?? 0, filtered)
      }
    }
    const report = this.hallDisplay.visible ? this.registrationReports.find(report => report.hallIndex === this.selectedHall) : undefined
    if (report) {
      ctx.save()
      ctx.lineWidth = 1.5 / view.scale
      ctx.strokeStyle = '#7b1fa2'
      ctx.setLineDash([6 / view.scale, 4 / view.scale])
      ctx.stroke(localPath([report.envelope], this.origin, true))
      if (report.alignment) {
        ctx.setLineDash([])
        ctx.strokeStyle = '#00a6bd'
        ctx.lineWidth = 3 / view.scale
        ctx.stroke(localPath([[report.alignment.target.start, report.alignment.target.end]], this.origin, false))
        ctx.strokeStyle = '#ef6c00'
        ctx.lineWidth = 2 / view.scale
        ctx.stroke(localPath([[report.alignment.source.start, report.alignment.source.end]], this.origin, false))
      }
      ctx.restore()
    }
    this.onZoom(Math.round(view.scale / fitViewport(this.data.bounds, size).scale * 100))
  }

  private drawGrid() {
    if (!this.view) return
    const { context: ctx, size, view, origin } = this
    const bounds = viewportBounds(view, size)
    const step = 100 / this.metersPerUnit
    ctx.strokeStyle = gridColor
    ctx.lineWidth = Math.max(0.5 / view.scale, 0.02 / this.metersPerUnit)
    ctx.setLineDash([])
    ctx.beginPath()
    for (let x = Math.floor((bounds.minX - origin.x) / step) * step; x <= bounds.maxX - origin.x; x += step) {
      ctx.moveTo(x, bounds.minY - origin.y)
      ctx.lineTo(x, bounds.maxY - origin.y)
    }
    for (let y = Math.floor((bounds.minY - origin.y) / step) * step; y <= bounds.maxY - origin.y; y += step) {
      ctx.moveTo(bounds.minX - origin.x, y)
      ctx.lineTo(bounds.maxX - origin.x, y)
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
