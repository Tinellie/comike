import type { OsmFeature, OsmMapData } from './osm'
import { featureLevels, tagValues } from './osm'
import { fitViewport, panViewport, rotatePoint, screenToWorld, viewportBounds, worldToScreen, zoomViewport } from './viewport'
import type { Point, Size, Viewport } from './viewport'
import { compareMapStyles, filteredLevelStyle, gridColor, hallLabel, mapBackground, mapStyle, matchesLevels, onewayTriangles } from './style'
import type { MapStyle } from './style'
import { HallMapLayer, defaultHallDisplay, hallMetadata, hallRouteColor } from './HallMapLayer'
import type { HallDisplay } from './HallMapLayer'
import { hallMatrix, hallWorldBounds } from './halls'
import { HallVisibility, intersectsBounds } from './hallVisibility'
import type { HallPlacement, HallTransforms, MapHall } from './halls'
import { outsideHallKey, projectHallPerimeter } from './hallPerimeter'
import { areaRoutePoint, boothRoutePoint, buildNavigation, shortestRoute } from './navigation'
import type { RoutePoint } from './navigation'
import type { Bounds } from './viewport'
import type { HallRegistrationReport } from './hallRegistration'
import { boothHover, BoothOccupancy } from './boothOccupancy'
import type { MapBoothData } from '../booths/api'
import type { PreviewBooth } from '../preview/data'
import type { FavoriteHighlights } from './favoriteHighlights'

interface StyledFeature {
  feature: OsmFeature
  path: Path2D
  arrows: Path2D
  style: MapStyle
  levels: number[]
}

export interface MapBoothHit {
  hallGroup: string
  island: string
  number: string
  suffix: 'a' | 'b'
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

function approachPoints({ origin, front, point }: RoutePoint): Point[] {
  if (!origin) return []
  return front ? [origin, front, point] : [origin, point]
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
  private readonly namedRoutePaths: { id: string; member: StyledFeature; area: boolean; color: string; fill: string }[]
  private selectedRoutes: ReadonlySet<string> = new Set()
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
  private pointer: Point | null = null
  private readonly hitIndexes = new WeakMap<MapHall, HallVisibility>()
  private readonly onHover: (label: string, clickable: boolean, hit: MapBoothHit | null) => void
  private hoverLabel = ''
  private hoverFrame: number | null = null
  private occupancy: BoothOccupancy | null = null
  private boothData: MapBoothData | null = null
  private favoriteHighlights: FavoriteHighlights | null = null
  private genreDisplay: { enabled: boolean; selected: ReadonlySet<string> | null } = { enabled: false, selected: null }

  setGenreDisplay(enabled: boolean, selected: string[] | null) {
    this.genreDisplay = { enabled, selected: selected ? new Set(selected) : null }
    this.requestDraw()
  }
  private hover: { hallIndex: number; bbox: PreviewBooth['bbox'] } | null = null
  private pdfImages: ReadonlyMap<MapHall, HTMLImageElement> = new Map()
  private routesVisible = true
  private navigation: ReturnType<typeof buildNavigation> | null = null
  private routeStart: RoutePoint | null = null
  private routeEnd: RoutePoint | null = null
  private routeLine: Path2D | null = null
  private routeApproach: Path2D | null = null
  private routeHover: { hallIndex: number; booth: PreviewBooth; bbox: PreviewBooth['bbox'] } | null = null

  hasNavigationSelection() { return this.routeStart !== null }

  clearNavigation() {
    this.routeStart = this.routeEnd = null
    this.routeLine = null
    this.routeApproach = null
    this.requestDraw()
  }

  selectNavigationPoint() {
    this.updateHover()
    const hover = this.routeHover
    if (!hover && (!this.pointer || !this.view)) return false
    if (this.routeEnd) return true
    this.navigation ??= buildNavigation(this.data, this.halls, this.transforms, hall => hallMetadata(hall).level)
    const selection = hover ? boothRoutePoint(this.navigation, hover.hallIndex, hover.booth, hover.bbox)
      : this.pointer && this.view ? areaRoutePoint(this.navigation, this.data.features,
        screenToWorld(this.pointer, this.view, this.size), this.selectedLevels) : null
    if (!selection) return false
    if (!selection.target) {
      console.warn('Map navigation:', selection.error)
      return true
    }
    if (!this.routeStart) {
      this.routeStart = selection.target
      this.routeApproach = localPath([approachPoints(selection.target)], this.origin, false)
      this.requestDraw()
      return true
    }
    const route = shortestRoute(this.navigation.nodes, this.navigation.edges, this.routeStart, selection.target)
    if (!route) {
      console.warn('Map navigation: 起点无法到达该终点。')
      return true
    }
    this.routeEnd = selection.target
    this.routeLine = localPath([route.points], this.origin, false)
    const startApproach = approachPoints(this.routeStart)
    const endApproach = approachPoints(this.routeEnd)
    this.routeApproach = localPath([startApproach, endApproach], this.origin, false)
    this.requestDraw()
    return true
  }
  private readonly perimeterPaths = new WeakMap<MapHall, {
    placement: HallPlacement; perimeter: Path2D; links: Path2D
  }>()

  private projectedPerimeter(hall: MapHall, placement: HallPlacement) {
    if (!hall.pathGraph) return null
    const key = outsideHallKey(hall.labels.map(label => label.code))
    const route = key ? this.data.outsideHallRoutes.get(key) : undefined
    if (!route?.length) return null
    const cached = this.perimeterPaths.get(hall)
    if (cached?.placement === placement) return cached
    const [a, b, c, d, e, f] = hallMatrix(hall, placement)
    const nodes = hall.pathGraph.nodes.map(({ x, y }) => ({ x: a * x + c * y + e, y: b * x + d * y + f }))
    const projection = projectHallPerimeter(nodes, hall.pathGraph.edges, route)
    if (projection.disconnected) {
      console.warn(`OSM outside-hall=${key}: ${projection.disconnected} 条框线边的投影位于不连通的路段，已跳过。`)
    }
    const paths = {
      placement, perimeter: localPath(projection.perimeter, this.origin, false),
      links: localPath(projection.links, this.origin, false),
    }
    this.perimeterPaths.set(hall, paths)
    return paths
  }

  setRoutesVisible(visible: boolean) {
    if (this.routesVisible === visible) return
    this.routesVisible = visible
    this.requestDraw()
  }

  setSelectedRoutes(routes: ReadonlySet<string>) {
    if (this.selectedRoutes === routes) return
    this.selectedRoutes = routes
    this.requestDraw()
  }

  setPdfImages(images: ReadonlyMap<MapHall, HTMLImageElement>) {
    this.pdfImages = images
    this.requestDraw()
  }

  setBoothData(data: MapBoothData | null) {
    if (this.boothData === data) return
    this.boothData = data
    this.occupancy = data ? new BoothOccupancy(data) : null
    this.requestDraw()
  }

  setFavoriteHighlights(highlights: FavoriteHighlights | null) {
    if (this.favoriteHighlights === highlights) return
    this.favoriteHighlights = highlights
    this.requestDraw()
  }

  constructor(
    canvas: HTMLCanvasElement,
    data: OsmMapData,
    onZoom: (percent: number) => void,
    onRotation: (degrees: number) => void = () => {},
    onHover: (label: string, clickable: boolean, hit: MapBoothHit | null) => void = () => {},
  ) {
    this.canvas = canvas
    this.data = data
    this.onZoom = onZoom
    this.onRotation = onRotation
    this.onHover = onHover
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
    const featurePaths = new Map(this.features.map(item => [item.feature.id, item]))
    this.namedRoutePaths = (data.namedRoutes ?? []).flatMap(({ id, hall, wayIds }) => {
      const color = hallRouteColor(hall)
      const tint = [1, 3, 5].map(offset => Math.round(255 * 0.7 + Number.parseInt(color.slice(offset, offset + 2), 16) * 0.3))
      const fill = `rgb(${tint.join(', ')})`
      return wayIds.flatMap(way => {
        const member = featurePaths.get(way)
        if (!member) return []
        const { feature } = member
        const [ring] = feature.paths
        // An explicitly tagged route area can also be a member of a separate multipolygon.
        const area = feature.area || (feature.polygonMember === true && tagValues(feature.tags, 'area').includes('yes')
          && feature.paths.length === 1 && ring.length >= 4 && ring[0] === ring.at(-1))
        return [{ id, member, area, color, fill }]
      })
    }).sort((a, b) => a.member.style.level - b.member.style.level)
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
    if (halls !== this.halls || transforms !== this.transforms) {
      this.navigation = null
      this.clearNavigation()
    }
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
    this.view = fitViewport(hallWorldBounds(hall, placement, this.pdfImages.has(hall)), this.size, this.view?.rotation ?? 0)
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

  setPointer(point: Point | null) {
    this.pointer = point
    if (this.hoverFrame !== null) return
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = null
      this.updateHover()
    })
  }

  pickBooth(point: Point): MapBoothHit | null {
    this.pointer = point
    return this.updateHover()
  }

  private updateHover(redraw = true): MapBoothHit | null {
    this.routeHover = null
    let label = ''
    let selected: MapBoothHit | null = null
    let hover: typeof this.hover = null
    if (this.pointer && this.view && this.hallDisplay.visible && this.hallDisplay.boxes
      && this.pointer.x >= 0 && this.pointer.y >= 0
      && this.pointer.x <= this.size.width && this.pointer.y <= this.size.height) {
      const world = screenToWorld(this.pointer, this.view, this.size)
      const query = { minX: world.x, maxX: world.x, minY: world.y, maxY: world.y }
      const candidates = this.transforms.placements.flatMap(placement => {
        const hall = this.halls.find(item => item.index === placement.hallIndex)
        if (!hall || !hall.page.hallOutline) return []
        const level = hallMetadata(hall).level
        if (!matchesLevels([level], this.selectedLevels)
          || !intersectsBounds(query, hallWorldBounds(hall, placement))) return []
        return [{ hall, placement, level }]
      }).sort((a, b) => a.level - b.level).reverse()
      for (const { hall, placement } of candidates) {
        const [a, b, c, d, e, f] = hallMatrix(hall, placement)
        const determinant = a * d - b * c
        const dx = world.x - e, dy = world.y - f
        let index = this.hitIndexes.get(hall)
        if (!index) {
          index = new HallVisibility(hall.page)
          this.hitIndexes.set(hall, index)
        }
        const hit = index.hitTest({
          x: (d * dx - c * dy) / determinant, y: (a * dy - b * dx) / determinant,
        })
        if (!hit) continue
        const islandCode = hit.block.islandId === null ? null : hall.islandCodes.get(hit.block.islandId)
        const appearance = boothHover(hit, islandCode ?? null, this.occupancy)
        this.routeHover = { hallIndex: hall.index, booth: hit.booth, bbox: hit.half.bbox }
        hover = appearance.bbox ? { hallIndex: hall.index, bbox: appearance.bbox } : null
        label = `${hall.name ?? `Hall ${hall.index + 1}`} / ${islandCode ?? hit.block.islandId ?? '?'} / ${hit.booth.number ?? '?'}${appearance.suffix}`
        if (appearance.bbox && hall.name && islandCode && hit.booth.number && (hit.half.suffix === 'a' || hit.half.suffix === 'b')) {
          selected = { hallGroup: hall.name, island: islandCode, number: hit.booth.number, suffix: hit.half.suffix }
        }
        break
      }
    }
    if (label !== this.hoverLabel) {
      this.hoverLabel = label
    }
    this.onHover(label, selected !== null, hover ? selected : null)
    if (hover?.hallIndex !== this.hover?.hallIndex || hover?.bbox !== this.hover?.bbox) {
      this.hover = hover
      if (redraw) this.requestDraw()
    }
    return selected
  }

  private sceneBounds(): Bounds {
    const bounds = { ...this.data.bounds }
    if (this.hallDisplay.visible) {
      for (const placement of this.transforms.placements) {
        const hall = this.halls.find(h => h.index === placement.hallIndex)
        if (!hall) continue
        const b = hallWorldBounds(hall, placement, this.pdfImages.has(hall))
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
    this.updateHover(false)
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
      if (!hall || !overlaps(hallWorldBounds(hall, placement, this.pdfImages.has(hall)))) return []
      const level = hallMetadata(hall).level
      return [{ hall, placement, level, filtered: !matchesLevels([level], this.selectedLevels) }]
    })
    const levels = [...new Set([...visible.map(item => item.style.level), ...hallItems.map(item => item.level)])]
      .sort((a, b) => a - b)
    const occupiedCodes = new Map<number, Set<string>>()
    if (this.hallDisplay.visible) {
      for (const hall of this.halls) {
        const level = hallMetadata(hall).level
        if (!hall.page.hallOutline || !matchesLevels([level], this.selectedLevels)
          || !this.transforms.placements.some(placement => placement.hallIndex === hall.index)) continue
        let codes = occupiedCodes.get(level)
        if (!codes) {
          codes = new Set()
          occupiedCodes.set(level, codes)
        }
        for (const label of hall.labels) {
          if (label.code) codes.add(label.code)
        }
      }
    }
    const highlighted = this.namedRoutePaths.filter(route => this.selectedRoutes.has(route.id))
    const stairArrows = highlighted.filter(({ area, member }) => !area && member.style.lineDash.length)
    const highlightedAreas = new Set(highlighted.filter(({ area }) => area).map(({ member }) => member.feature.id))
    for (const level of levels) {
      const items = visible.filter(item => item.style.level === level)
      for (const { feature, path, style, arrows, filtered } of items) {
        if (highlightedAreas.has(feature.id)) continue
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
      this.drawLabels(items, occupiedCodes.get(level))
      ctx.restore()
      for (const { hall, placement, filtered } of hallItems.filter(item => item.level === level)) {
        this.hallLayer.draw(ctx, hall, placement, this.origin, this.hallDisplay,
          hall.index === this.selectedHall, view.rotation ?? 0, filtered, true, this.occupancy,
          this.hover?.hallIndex === hall.index ? this.hover.bbox : null, this.pdfImages.get(hall), this.genreDisplay)
        if (this.routesVisible && !filtered) {
          const projected = this.projectedPerimeter(hall, placement)
          if (projected) {
            ctx.save()
            ctx.strokeStyle = '#007b91'
            ctx.lineCap = 'round'
            ctx.lineWidth = 2 / view.scale
            ctx.stroke(projected.perimeter)
            ctx.setLineDash([4 / view.scale, 3 / view.scale])
            ctx.stroke(projected.links)
            ctx.restore()
          }
          this.hallLayer.drawRoutes(ctx, hall, placement, this.origin, dpr, !projected)
        }
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
    if (this.hallDisplay.visible && this.favoriteHighlights) {
      for (const { hall, placement, filtered } of hallItems) {
        const highlights = this.favoriteHighlights.byHall.get(hall.index)
        if (!filtered && highlights?.length) this.hallLayer.drawFavorites(ctx, hall, placement, this.origin, highlights)
      }
    }
    if (highlighted.length) {
      ctx.save()
      ctx.lineJoin = ctx.lineCap = 'round'
      const stairWidth = 2.6
      const strokeRoute = ({ path, style }: StyledFeature, casing = 0) => {
        ctx.lineWidth = ((style.lineDash.length ? stairWidth : 1.8) + casing) / this.metersPerUnit
        ctx.setLineDash(casing ? [] : style.lineDash.map(length => length / this.metersPerUnit))
        ctx.lineCap = style.lineDash.length ? 'butt' : 'round'
        ctx.stroke(path)
      }
      for (const level of new Set(highlighted.map(({ member }) => member.style.level))) {
        const items = highlighted.filter(({ member }) => member.style.level === level)
        for (const { member, area, fill } of items) {
          if (!area) continue
          ctx.fillStyle = fill
          ctx.fill(member.path, 'evenodd')
        }
        const lines = items.filter(({ area }) => !area)
        ctx.strokeStyle = '#fff'
        for (const { member } of lines) strokeRoute(member, 1.2)
        ctx.save()
        ctx.setLineDash([])
        ctx.lineCap = 'butt'
        ctx.lineWidth = stairWidth / this.metersPerUnit
        ctx.globalAlpha = 0.5
        for (const { member, color } of lines) {
          if (!member.style.lineDash.length) continue
          ctx.strokeStyle = color
          ctx.stroke(member.path)
        }
        ctx.restore()
        ctx.setLineDash([])
        ctx.lineCap = 'round'
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.2 / this.metersPerUnit
        for (const { member } of lines) {
          if (!member.style.lineDash.length) ctx.stroke(member.arrows)
        }
        for (const { member, color } of lines) {
          ctx.strokeStyle = ctx.fillStyle = color
          strokeRoute(member)
          if (!member.style.lineDash.length) ctx.fill(member.arrows)
        }
      }
      ctx.restore()
    }
    if (this.routeStart) {
      ctx.save()
      ctx.setLineDash([])
      ctx.lineJoin = ctx.lineCap = 'round'
      if (this.routeLine) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 8 / view.scale
        ctx.stroke(this.routeLine)
        ctx.strokeStyle = '#df4913'
        ctx.lineWidth = 5 / view.scale
        ctx.stroke(this.routeLine)
      }
      if (this.routeApproach) {
        ctx.setLineDash([5 / view.scale, 4 / view.scale])
        ctx.strokeStyle = '#df4913'
        ctx.lineWidth = 3 / view.scale
        ctx.stroke(this.routeApproach)
        ctx.setLineDash([])
      }
      for (const [marker, color] of [[this.routeStart, '#067348'], [this.routeEnd, '#df4913']] as const) {
        if (!marker) continue
        ctx.beginPath()
        const point = marker.origin ?? marker.point
        ctx.arc(point.x - this.origin.x, point.y - this.origin.y, 6 / view.scale, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2 / view.scale
        ctx.stroke()
      }
      ctx.restore()
    }
    if (stairArrows.length) {
      ctx.save()
      ctx.setLineDash([])
      ctx.lineJoin = 'round'
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.2 / this.metersPerUnit
      for (const { member, color } of stairArrows) {
        ctx.stroke(member.arrows)
        ctx.fillStyle = color
        ctx.fill(member.arrows)
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

  private drawLabels(features: StyledFeature[], occupiedCodes?: ReadonlySet<string>) {
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
      const label = hallLabel(feature.tags, occupiedCodes)
      if (!label) continue
      const b = feature.bounds
      const p = worldToScreen({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, view, this.size)
      const width = ctx.measureText(label.text).width + 10
      if (p.x + width / 2 < 0 || p.y + fontSize / 2 < 0
        || p.x - width / 2 > this.size.width || p.y - fontSize / 2 > this.size.height) continue
      if (occupied.some(other => Math.abs(p.x - other.x) < (width + other.width) / 2
        && Math.abs(p.y - other.y) < fontSize + 4)) continue
      occupied.push({ ...p, width })
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)'
      ctx.lineWidth = Math.max(2.6, groundZoom)
      ctx.strokeText(label.text, p.x, p.y)
      ctx.fillStyle = label.color
      ctx.fillText(label.text, p.x, p.y)
    }
  }

  dispose() {
    if (this.hoverFrame !== null) cancelAnimationFrame(this.hoverFrame)
    this.hoverFrame = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }
}
