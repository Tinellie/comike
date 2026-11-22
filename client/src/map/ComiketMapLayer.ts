import type { OsmMapData } from './osm'
import { featureLevels, tagValues } from './osm'
import { rotatePoint, screenToWorld, worldToScreen } from './viewport'
import type { Point } from './viewport'
import { filteredLevelStyle, hallLabel, matchesLevels } from './style'
import { HallMapLayer, defaultHallDisplay, hallMetadata, hallRouteColor } from './HallMapLayer'
import type { HallDisplay } from './HallMapLayer'
import { hallMatrix, hallWorldBounds } from './halls'
import { HallVisibility, intersectsBounds } from './hallVisibility'
import type { HallPlacement, HallTransforms, MapHall } from './halls'
import { outsideHallKey, projectHallPerimeter } from './hallPerimeter'
import { areaRoutePoint, boothRoutePoint, buildNavigation, greedyBoothRoute, plannerRouteProgress, queueStart, reorderBoothRoute, shortestRoute } from './navigation'
import type { PlannerSide, RoutePoint, RouteStep } from './navigation'
import type { Bounds } from './viewport'
import type { HallRegistrationReport } from './hallRegistration'
import { boothHover, BoothOccupancy } from './boothOccupancy'
import type { MapBoothData } from '../booths/api'
import type { PreviewBooth } from '../preview/data'
import type { FavoriteHighlights } from './favoriteHighlights'
import { localPath } from './basemap/BasemapRenderer'
import type { BasemapFrame, BasemapPass, BasemapRenderer, StyledFeature } from './basemap/BasemapRenderer'

export interface MapBoothHit {
  hallGroup: string
  island: string
  number: string
  suffix: 'a' | 'b'
}

export interface RouteListStop {
  id: string
  hit: MapBoothHit
  suffix: 'a' | 'b' | 'ab'
  colour: string
}

type PlannedStop = RoutePoint & RouteListStop & { hallIndex: number; bbox: PreviewBooth['bbox']; coefficient: number }
type PlannedRoute = { queue: NonNullable<ReturnType<typeof queueStart>>; visited: PlannedStop[]; legs: RouteStep[][] }

function approachPoints({ origin, front, point }: RoutePoint): Point[] {
  if (!origin) return []
  return front ? [origin, front, point] : [origin, point]
}

const plannerHueBase = 220
const plannerHueRange = 360

function plannerHue(progress: number) {
  return plannerHueBase + plannerHueRange * (1 - progress)
}

function plannerProgressColor(progress: number) {
  return `hsl(${plannerHue(progress)}, 85%, 42%)`
}

function plannerGradient(ctx: CanvasRenderingContext2D, a: Point, b: Point, from: number, to: number,
  color: (progress: number, offset: number) => string = plannerProgressColor) {
  const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
  gradient.addColorStop(0, color(from, 0))
  // Canvas interpolates RGB; stop at each hue-sector boundary to preserve the color sweep.
  for (let hue = Math.ceil(plannerHue(from) / 60) * 60 - 60; hue > plannerHueBase; hue -= 60) {
    const progress = 1 - (hue - plannerHueBase) / plannerHueRange
    if (progress >= to) break
    if (progress > from) {
      const offset = (progress - from) / (to - from)
      gradient.addColorStop(offset, color(progress, offset))
    }
  }
  gradient.addColorStop(1, color(to, 1))
  return gradient
}

export class ComiketMapLayer {
  private readonly map: BasemapRenderer
  private readonly data: OsmMapData
  private readonly routeContext: CanvasRenderingContext2D
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private routeFrame: number | null = null
  private readonly levelsByFeature = new Map<StyledFeature, number[]>()
  private readonly namedRoutePaths: { id: string; member: StyledFeature; area: boolean; color: string; fill: string }[]
  private selectedRoutes: ReadonlySet<string> = new Set()
  private get size() { return this.map.size }
  private get view() { return this.map.view }
  private get pixelRatio() { return this.map.pixelRatio }
  private get origin() { return this.map.origin }
  private get metersPerUnit() { return this.map.metersPerUnit }
  private halls: MapHall[] = []
  private transforms: HallTransforms = { schemaVersion: 1, placements: [] }
  private hallDisplay: HallDisplay = defaultHallDisplay
  private selectedHall: number | null = null
  private registrationReports: HallRegistrationReport[] = []
  private readonly hallLayer = new HallMapLayer()
  private selectedLevels = new Set<number>()
  private pointer: Point | null = null
  private readonly hitIndexes = new WeakMap<MapHall, HallVisibility>()
  private readonly onHover: (label: string, clickable: boolean, hit: MapBoothHit | null, colour?: string) => void
  private readonly onPlannedRoute: (stops: RouteListStop[]) => void
  private hoverLabel = ''
  private hoverFrame: number | null = null
  private occupancy: BoothOccupancy | null = null
  private boothData: MapBoothData | null = null
  private favoriteHighlights: FavoriteHighlights | null = null
  private readonly boothColours = new Map<PreviewBooth['bbox'], string>()
  private genreDisplay: { enabled: boolean; selected: ReadonlySet<string> | null } = { enabled: false, selected: null }

  setGenreDisplay(enabled: boolean, selected: string[] | null) {
    this.genreDisplay = { enabled, selected: selected ? new Set(selected) : null }
    this.requestDraw()
  }
  private hover: { hallIndex: number; bbox: PreviewBooth['bbox'] } | null = null
  private pdfImages: ReadonlyMap<MapHall, HTMLImageElement> = new Map()
  private routesVisible = false
  private navigation: ReturnType<typeof buildNavigation> | null = null
  private routeStart: RoutePoint | null = null
  private routeEnd: RoutePoint | null = null
  private routeLine: Path2D | null = null
  private routeApproach: Path2D | null = null
  private plannedRoute: PlannedRoute | null = null
  private inspectedStop: PlannedStop | null = null
  private plannedSegments: { line: Path2D; start: Point; end: Point; from: number; to: number }[] = []
  private plannedApproaches: { path: Path2D; color: string }[] = []
  private plannedBoothFlashes: { corners: Point[]; distance: number; colour: string }[] = []
  private routeHover: { hallIndex: number; booth: PreviewBooth; bbox: PreviewBooth['bbox'] } | null = null

  hasNavigationSelection() { return this.routeStart !== null }

  clearNavigation() {
    if (this.plannedRoute) {
      this.plannedRoute = null
      this.inspectedStop = null
      this.onPlannedRoute([])
    }
    this.plannedSegments = []
    this.stopRoutePulses()
    this.plannedApproaches = []
    this.plannedBoothFlashes = []
    this.routeStart = this.routeEnd = null
    this.routeLine = null
    this.routeApproach = null
    this.requestDraw()
  }

  clearPlannedRoute() {
    if (this.plannedRoute) this.clearNavigation()
  }

  reorderPlannedRoute(from: number, to: number): string | null {
    const route = this.plannedRoute
    if (!route || !this.navigation || !route.visited[from] || !route.visited[to]) return '路线已失效，请重新计算。'
    if (from === to) return null
    const reordered = reorderBoothRoute(this.navigation, route.queue.start, route, from, to)
    if (!reordered) return '按此顺序无法到达所有摊位，已保留原路线。'
    this.drawPlannedRoute({ queue: route.queue, ...reordered })
    return null
  }

  inspectPlannedStop(stop: RouteListStop | null) {
    this.inspectedStop = this.plannedRoute?.visited.find(candidate => candidate === stop) ?? null
    const point = this.inspectedStop?.origin
    if (point && this.view) {
      const { x, y } = worldToScreen(point, this.view, this.size)
      const { width, height } = this.size
      if (x < 0 || x > width || y < 0 || y > height) {
        this.map.centerOn(point)
      }
    }
    this.requestDraw()
  }

  plannedStopAnchor(): Point | null {
    const point = this.inspectedStop?.origin
    if (!point || !this.view) return null
    const { left, top } = this.map.canvas.getBoundingClientRect()
    const { x, y } = worldToScreen(point, this.view, this.size)
    return { x: left + x, y: top + y }
  }

  planFavoriteRoute(side: PlannerSide, coefficients: ReadonlyMap<string, number>): string | null {
    this.clearPlannedRoute()
    const favorites = this.favoriteHighlights
    if (!favorites || (!favorites.stops.length && !favorites.unmatched)) return '当天没有收藏摊位。'
    const eligible = favorites.stops.flatMap(stop => {
      const coefficient = Math.max(...stop.colours.map(colour => coefficients.get(colour) ?? 1))
      return coefficient === 0 ? [] : [{ ...stop, coefficient }]
    })
    let unmatched = 0
    for (const [colour, count] of favorites.unmatchedByColour) {
      if (coefficients.get(colour) !== 0) unmatched += count
    }
    if (!eligible.length) return unmatched ? '收藏摊位无法匹配当前地图。' : '没有参与路线规划的收藏摊位。'
    const navigation = this.navigation ??= buildNavigation(this.data, this.halls, this.transforms, hall => hallMetadata(hall).level)
    const queue = queueStart(this.data, navigation, side)
    if (!queue) return `无法接入${side}待機列。`
    const targets = eligible.flatMap(({ hallIndex, booth, bbox, coefficient, colours }): PlannedStop[] => {
      const { target } = boothRoutePoint(navigation, hallIndex, booth, bbox)
      const hall = navigation.byHall.get(hallIndex)?.hall
      const island = booth.islandId && hall?.islandCodes.get(booth.islandId)
      if (!target || !hall?.name || !island || !booth.number) return []
      const half = hall.page.halfBooths?.find(half => half.bbox === bbox)?.suffix
      const suffix = half === 'a' || half === 'b' ? half : 'ab'
      return [{ ...target, coefficient, hallIndex, bbox, suffix, id: JSON.stringify([hallIndex, booth.id, suffix]),
        colour: this.boothColours.get(bbox) ?? colours[0],
        hit: { hallGroup: hall.name, island, number: booth.number, suffix: suffix === 'b' ? 'b' : 'a' } }]
    })
    const { legs, visited } = greedyBoothRoute(navigation, queue.start, targets)
    if (!visited.length) return `无法从${side}待機列到达收藏摊位。`
    this.drawPlannedRoute({ queue, visited, legs })
    const skipped = eligible.length + unmatched - visited.length
    return skipped ? `${skipped} 个收藏摊位未能纳入路线。` : null
  }

  private drawPlannedRoute(route: PlannedRoute) {
    this.plannedRoute = route
    const { queue, visited, legs } = route
    const entry = queue.points.slice(1).map((end, i) => ({ start: queue.points[i], end }))
    const progress = plannerRouteProgress([entry, ...legs])
    this.plannedSegments = progress.flat().filter(({ start, end }) => start.x !== end.x || start.y !== end.y)
      .map(step => ({ ...step, line: localPath([[step.start, step.end]], this.origin, false) }))
    this.plannedApproaches = visited.map((stop, index) => ({
      path: localPath([approachPoints(stop)], this.origin, false),
      color: plannerProgressColor(progress[index + 1].at(-1)?.to ?? 0),
    }))
    const legLength = (steps: typeof entry) => steps.reduce((sum, { start, end }) =>
      sum + Math.hypot(end.x - start.x, end.y - start.y), 0)
    let distance = legLength(entry)
    this.plannedBoothFlashes = visited.map(({ hallIndex, bbox, colour }, index) => {
      distance += legLength(legs[index])
      const { toWorld } = this.navigation!.byHall.get(hallIndex)!
      const { x, y, width, height } = bbox
      const corners = [
        { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
      ].map(toWorld)
      return { corners, distance, colour }
    })
    this.routeStart = { ...queue.start, origin: queue.points[0] }
    this.routeEnd = visited[visited.length - 1]
    this.routeLine = localPath([[...queue.points, ...legs.flatMap(steps => steps.map(step => step.end))]], this.origin, false)
    this.routeApproach = null
    this.requestDraw()
    this.updateRoutePulses()
    this.onPlannedRoute(visited)
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

  setFavoriteHighlights(highlights: FavoriteHighlights | null, preserveRoute = false) {
    if (this.favoriteHighlights === highlights) return
    if (!preserveRoute) this.clearPlannedRoute()
    this.favoriteHighlights = highlights
    this.boothColours.clear()
    for (const groups of highlights?.byHall.values() ?? []) {
      for (const { colour, rectangles } of groups) {
        for (const rectangle of rectangles) this.boothColours.set(rectangle, colour)
      }
    }
    if (this.plannedRoute) {
      const visited = this.plannedRoute.visited.map(stop => {
        const colour = this.boothColours.get(stop.bbox)
        return colour && colour !== stop.colour ? { ...stop, colour } : stop
      })
      this.inspectedStop = visited.find(stop => stop.id === this.inspectedStop?.id) ?? null
      this.drawPlannedRoute({ ...this.plannedRoute, visited })
    }
    this.requestDraw()
  }

  constructor(
    map: BasemapRenderer,
    routeCanvas: HTMLCanvasElement,
    data: OsmMapData,
    onHover: (label: string, clickable: boolean, hit: MapBoothHit | null, colour?: string) => void = () => {},
    onPlannedRoute: (stops: RouteListStop[]) => void = () => {},
  ) {
    this.map = map
    this.data = data
    this.onHover = onHover
    this.onPlannedRoute = onPlannedRoute
    const routeContext = routeCanvas.getContext('2d')
    if (!routeContext) throw new Error('浏览器无法创建 Canvas 2D 上下文')
    this.routeContext = routeContext
    for (const item of map.features) this.levelsByFeature.set(item, featureLevels(item.feature.tags))
    const featurePaths = new Map(map.features.map(item => [item.feature.id, item]))
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
    this.reducedMotion.addEventListener('change', this.updateRoutePulses)
  }

  resize(width: number, height: number) {
    this.routeContext.canvas.width = width
    this.routeContext.canvas.height = height
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
    this.map.fit(hallWorldBounds(hall, placement, this.pdfImages.has(hall)))
  }

  setRegistrationReports(reports: HallRegistrationReport[]) {
    this.registrationReports = reports
    this.requestDraw()
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
    let colour: string | undefined
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
        if (hover) colour = this.boothColours.get(hover.bbox)
          ?? this.boothColours.get(hit.half.bbox) ?? this.boothColours.get(hit.booth.bbox)
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
    this.onHover(label, selected !== null, hover ? selected : null, colour)
    if (hover?.hallIndex !== this.hover?.hallIndex || hover?.bbox !== this.hover?.bbox) {
      this.hover = hover
      if (redraw) this.requestDraw()
    }
    return selected
  }

  fitBounds(): Bounds {
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

  private requestDraw() { this.map.requestDraw() }

  prepare({ context: ctx, view, pixelRatio: dpr, overlaps }: BasemapFrame): BasemapPass {
    this.updateHover(false)
    const hallItems = this.transforms.placements.flatMap(placement => {
      const hall = this.halls.find(h => h.index === placement.hallIndex)
      if (!hall || !overlaps(hallWorldBounds(hall, placement, this.pdfImages.has(hall)))) return []
      const level = hallMetadata(hall).level
      return [{ hall, placement, level, filtered: !matchesLevels([level], this.selectedLevels) }]
    })
    hallItems.sort((a, b) => a.level - b.level)
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
    const levelSelected = (item: StyledFeature) => matchesLevels(this.levelsByFeature.get(item) ?? [], this.selectedLevels)
    const afterLevel = (level: number) => {
      for (const { hall, placement, filtered } of hallItems.filter(item => item.level === level)) {
        this.hallLayer.draw(ctx, hall, placement, this.origin, this.hallDisplay,
          hall.index === this.selectedHall, view.rotation ?? 0, filtered, true, this.occupancy,
          (this.inspectedStop ?? this.hover)?.hallIndex === hall.index ? (this.inspectedStop ?? this.hover)!.bbox : null,
          this.pdfImages.get(hall), this.genreDisplay)
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
    return {
      levels: hallItems.map(item => item.level),
      featureStyle: item => highlightedAreas.has(item.feature.id) ? null : levelSelected(item) ? item.style
        : filteredLevelStyle({ ...item.style, hallLabel: null, lineDash: [...item.style.lineDash] }),
      showArrows: levelSelected,
      label: item => levelSelected(item) && 'hallLabel' in item.style && item.style.hallLabel
        ? hallLabel(item.feature.tags, occupiedCodes.get(item.style.level)) : null,
      afterLevel,
      afterFeatures: () => this.drawOverlays(ctx, view.scale, hallItems, highlighted, stairArrows),
    }
  }

  private drawOverlays(ctx: CanvasRenderingContext2D, scale: number,
    hallItems: { hall: MapHall; placement: HallPlacement; filtered: boolean }[],
    highlighted: ComiketMapLayer['namedRoutePaths'], stairArrows: ComiketMapLayer['namedRoutePaths']) {
    const report = this.hallDisplay.visible ? this.registrationReports.find(report => report.hallIndex === this.selectedHall) : undefined
    if (report) {
      ctx.save()
      ctx.lineWidth = 1.5 / scale
      ctx.strokeStyle = '#7b1fa2'
      ctx.setLineDash([6 / scale, 4 / scale])
      ctx.stroke(localPath([report.envelope], this.origin, true))
      if (report.alignment) {
        ctx.setLineDash([])
        ctx.strokeStyle = '#00a6bd'
        ctx.lineWidth = 3 / scale
        ctx.stroke(localPath([[report.alignment.target.start, report.alignment.target.end]], this.origin, false))
        ctx.strokeStyle = '#ef6c00'
        ctx.lineWidth = 2 / scale
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
        ctx.lineWidth = (this.plannedSegments.length ? 5 : 8) / scale
        ctx.stroke(this.routeLine)
      }
      ctx.lineWidth = (this.plannedSegments.length ? 3 : 5) / scale
      if (this.plannedSegments.length) {
        for (const { line, start, end, from, to } of this.plannedSegments) {
          if (from === to) {
            ctx.strokeStyle = plannerProgressColor(from)
          } else {
            const { x, y } = this.origin
            ctx.strokeStyle = plannerGradient(ctx, { x: start.x - x, y: start.y - y },
              { x: end.x - x, y: end.y - y }, from, to)
          }
          ctx.stroke(line)
        }
      } else if (this.routeLine) {
        ctx.strokeStyle = '#df4913'
        ctx.stroke(this.routeLine)
      }
      if (this.routeApproach || this.plannedSegments.length) {
        ctx.setLineDash([5 / scale, 4 / scale])
        ctx.lineWidth = 3 / scale
        if (this.routeApproach) {
          ctx.strokeStyle = '#df4913'
          ctx.stroke(this.routeApproach)
        }
        for (const { path, color } of this.plannedApproaches) {
          ctx.strokeStyle = color
          ctx.stroke(path)
        }
        ctx.setLineDash([])
      }
      for (const [marker, color] of [
        [this.routeStart, this.plannedSegments.length ? plannerProgressColor(0) : '#067348'],
        [this.routeEnd, this.plannedApproaches.at(-1)?.color ?? '#df4913'],
      ] as const) {
        if (!marker) continue
        ctx.beginPath()
        const point = marker.origin ?? marker.point
        ctx.arc(point.x - this.origin.x, point.y - this.origin.y, 6 / scale, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2 / scale
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
  }

  private stopRoutePulses() {
    if (this.routeFrame !== null) cancelAnimationFrame(this.routeFrame)
    this.routeFrame = null
    const ctx = this.routeContext
    ctx.resetTransform()
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  }

  private updateRoutePulses = () => {
    if (this.reducedMotion.matches || !this.plannedSegments.length) {
      this.stopRoutePulses()
    } else if (this.routeFrame === null) {
      this.routeFrame = requestAnimationFrame(this.drawRoutePulses)
    }
  }

  private drawRoutePulses = (time: number) => {
    this.routeFrame = null
    const { routeContext: ctx, view, size, pixelRatio } = this
    if (!view) return
    const { metersPerUnit } = this
    const pulseLength = 128 * metersPerUnit / view.scale, radius = 3.5
    const speed = 0.18 // Ground meters per millisecond.
    const spacing = 10240 / 12 // Ground meters between pulse heads.
    const phase = time * speed % spacing
    let offset = phase
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)
    ctx.lineWidth = radius * 2
    ctx.lineCap = 'round'
    for (const { start, end, from, to } of this.plannedSegments) {
      const a = worldToScreen(start, view, size)
      const b = worldToScreen(end, view, size)
      const length = Math.hypot(end.x - start.x, end.y - start.y) * metersPerUnit
      if (!length) continue
      let first = 0, last = 1
      for (const axis of ['x', 'y'] as const) {
        const limit = axis === 'x' ? size.width : size.height
        const delta = b[axis] - a[axis]
        if (delta === 0) {
          if (a[axis] < -radius || a[axis] > limit + radius) last = -1
          continue
        }
        const low = (-radius - a[axis]) / delta
        const high = (limit + radius - a[axis]) / delta
        first = Math.max(first, Math.min(low, high))
        last = Math.min(last, Math.max(low, high))
      }
      if (first <= last) {
        const visibleStart = first * length, visibleEnd = last * length
        const advance = Math.ceil((visibleStart - offset) / spacing)
        const pointAt = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
        for (let head = offset + advance * spacing; head - pulseLength < visibleEnd; head += spacing) {
          const tail = head - pulseLength
          const begin = Math.max(tail, visibleStart), finish = Math.min(head, visibleEnd)
          if (begin >= finish) continue
          const p = pointAt(begin / length), q = pointAt(finish / length)
          ctx.strokeStyle = plannerGradient(ctx, p, q,
            from + (to - from) * begin / length, from + (to - from) * finish / length,
            (progress, t) => {
              const opacity = (begin - tail + (finish - begin) * t) / pulseLength
              return `hsl(${plannerHue(progress)}, 85%, 65%, ${opacity})`
            })
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(q.x, q.y)
          ctx.stroke()
        }
      }
      offset = ((offset - length) % spacing + spacing) % spacing
    }
    const flashDuration = 1200
    ctx.save()
    ctx.lineJoin = 'round'
    for (const { corners, distance, colour } of this.plannedBoothFlashes) {
      const sinceArrival = ((phase - distance * metersPerUnit) % spacing + spacing) % spacing / speed
      if (sinceArrival >= flashDuration) continue
      const progress = sinceArrival / flashDuration
      const strength = 1 - progress ** 2
      const points = corners.map(corner => worldToScreen(corner, view, size))
      ctx.beginPath()
      points.forEach(({ x, y }, index) => {
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.closePath()
      ctx.globalAlpha = 0.9 * strength
      ctx.fillStyle = colour
      ctx.fill()
      ctx.globalAlpha = strength
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 8
      ctx.stroke()
      ctx.strokeStyle = colour
      ctx.lineWidth = 5
      ctx.stroke()
      const [a, , b] = points
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const radius = Math.hypot(a.x - center.x, a.y - center.y)
      if (radius > 0) {
        const expansion = 1 + 12 * (1 - (1 - progress) ** 2) / radius
        ctx.beginPath()
        points.forEach((point, index) => {
          const x = center.x + (point.x - center.x) * expansion
          const y = center.y + (point.y - center.y) * expansion
          if (index === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.closePath()
        ctx.globalAlpha = 0.85 * strength
        ctx.lineWidth = 4
        ctx.stroke()
      }
    }
    ctx.restore()
    this.updateRoutePulses()
  }

  dispose() {
    this.reducedMotion.removeEventListener('change', this.updateRoutePulses)
    this.stopRoutePulses()
    if (this.hoverFrame !== null) cancelAnimationFrame(this.hoverFrame)
    this.hoverFrame = null
  }
}
