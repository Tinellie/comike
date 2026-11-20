import { BlockLayer } from '../preview/BlockLayer'
import { NumberLayer } from '../preview/layers'
import type { CanvasLayer, PreviewOptions } from '../preview/layers'
import type { Bounds, Point } from './viewport'
import type { HallPlacement, MapHall } from './halls'
import { hallMatrix, hallTextRotation, object } from './halls'
import hallMetaSource from '../../../ref/hall-meta.json?raw'
import { filteredOutline } from './style'
import { HallVisibility, intersectsBounds, paddedBounds } from './hallVisibility'
import type { BoothOccupancy } from './boothOccupancy'
import type { PreviewBooth } from '../preview/data'
import { inverseTransform } from '../preview/pdfPreview'
import type { FavoriteHighlight } from './favoriteHighlights'

const hallMeta = object(JSON.parse(hallMetaSource))
if (!Array.isArray(hallMeta.halls)) throw new Error('Hall marker 元数据列表无效')
const hallEntries = hallMeta.halls.map(value => {
  const entry = object(value)
  if (typeof entry.name !== 'string' || !entry.name
    || typeof entry.code !== 'string' || !/^[EWSN]$/.test(entry.code)
    || typeof entry['marker-color'] !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry['marker-color'])
    || typeof entry.level !== 'number' || !Number.isFinite(entry.level)) {
    throw new Error('Hall marker 名称、编号、颜色或 level 无效')
  }
  return { name: entry.name, code: entry.code, color: entry['marker-color'], level: entry.level }
})

export function hallMetadata(hall: MapHall) {
  const codes = new Set(hall.labels.flatMap(label => label.code ? [label.code[0]] : []))
  const matches = hallEntries.filter(entry => codes.size > 0
    ? codes.has(entry.code) : hall.name?.startsWith(entry.name))
  if (matches.length !== 1) throw new Error(`Hall ${hall.name ?? hall.index + 1} 缺少唯一 marker-color 配置`)
  return matches[0]
}

export function hallMarkerColor(hall: MapHall): string {
  return hallMetadata(hall).color
}

export interface HallDisplay {
  visible: boolean
  boxes: boolean
  numbers: boolean
  halfBooths: boolean
  islands: boolean
  labels: boolean
}

export const defaultHallDisplay: HallDisplay = {
  visible: true, boxes: true, numbers: true, halfBooths: false, islands: true, labels: true,
}

export class HallMapLayer {
  private readonly layers: CanvasLayer[] = [
    new BlockLayer(), new NumberLayer(),
  ]
  private readonly image = new Image()
  private readonly visibility = new WeakMap<MapHall, HallVisibility>()
  private readonly blockBackgrounds = new WeakMap<MapHall, Map<string, Path2D>>()
  private readonly regionPaths = new WeakMap<readonly PreviewBooth['bbox'][], Path2D>()
  private readonly routePaths = new WeakMap<MapHall, { indoor: Path2D; perimeter: Path2D }>()

  drawRoutes(
    context: CanvasRenderingContext2D, hall: MapHall, placement: HallPlacement, origin: Point, pixelRatio: number,
    showOriginalPerimeter: boolean,
  ) {
    if (!hall.pathGraph) return
    let paths = this.routePaths.get(hall)
    if (!paths) {
      paths = { indoor: new Path2D(), perimeter: new Path2D() }
      const { nodes, edges } = hall.pathGraph
      for (const { from, to, kind } of edges) {
        paths[kind].moveTo(nodes[from].x, nodes[from].y)
        paths[kind].lineTo(nodes[to].x, nodes[to].y)
      }
      this.routePaths.set(hall, paths)
    }
    const [a, b, c, d, e, f] = hallMatrix(hall, placement)
    context.save()
    context.transform(a, b, c, d, e - origin.x, f - origin.y)
    const matrix = context.getTransform()
    context.lineWidth = 2 * pixelRatio / Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d))
    context.lineCap = 'round'
    context.setLineDash([])
    if (showOriginalPerimeter) {
      context.strokeStyle = '#007b91'
      context.stroke(paths.perimeter)
    }
    context.strokeStyle = '#2454d4'
    context.stroke(paths.indoor)
    context.restore()
  }

  private path(rectangles: readonly PreviewBooth['bbox'][]) {
    let path = this.regionPaths.get(rectangles)
    if (!path) {
      path = new Path2D()
      for (const b of rectangles) path.rect(b.x, b.y, b.width, b.height)
      this.regionPaths.set(rectangles, path)
    }
    return path
  }

  drawFavorites(
    context: CanvasRenderingContext2D, hall: MapHall, placement: HallPlacement,
    origin: Point, highlights: readonly FavoriteHighlight[],
  ) {
    const [a, b, c, d, e, f] = hallMatrix(hall, placement)
    context.save()
    context.transform(a, b, c, d, e - origin.x, f - origin.y)
    context.globalAlpha = 0.7
    for (const highlight of highlights) {
      context.fillStyle = highlight.colour
      context.fill(this.path(highlight.rectangles))
    }
    context.restore()
  }

  draw(
    context: CanvasRenderingContext2D, hall: MapHall, placement: HallPlacement,
    origin: Point, display: HallDisplay, _selected: boolean, viewRotation = 0, filtered = false,
    cull = true, occupancy: BoothOccupancy | null = null, hover: PreviewBooth['bbox'] | null = null,
    pdfImage: HTMLImageElement | undefined = undefined,
    genreDisplay: { enabled: boolean; selected: ReadonlySet<string> | null } = { enabled: false, selected: null },
  ) {
    if (!display.visible || !hall.page.hallOutline) return
    const markerColor = hallMarkerColor(hall)
    const [a, b, c, d, e, f] = hallMatrix(hall, placement)
    context.save()
    context.transform(a, b, c, d, e - origin.x, f - origin.y)
    if (pdfImage && hall.page.pdfPreview && !filtered) {
      const pdf = hall.page.pdfPreview
      context.save()
      context.transform(...inverseTransform(pdf.transform))
      context.globalAlpha = 0.35
      context.drawImage(pdfImage, 0, 0, pdf.width, pdf.height)
      context.restore()
    }
    let view: Bounds | null = null
    if (cull) {
      const inverse = context.getTransform().inverse()
      const points = [
        inverse.transformPoint({ x: 0, y: 0 }),
        inverse.transformPoint({ x: context.canvas.width, y: 0 }),
        inverse.transformPoint({ x: context.canvas.width, y: context.canvas.height }),
        inverse.transformPoint({ x: 0, y: context.canvas.height }),
      ]
      view = {
        minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)),
        maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)),
      }
    }
    let visibility = this.visibility.get(hall)
    if (!visibility) {
      visibility = new HallVisibility(hall.page)
      this.visibility.set(hall, visibility)
    }
    let backgrounds = this.blockBackgrounds.get(hall)
    if (!backgrounds) {
      backgrounds = new Map()
      const booths = new Map(hall.page.booths.map(booth => [booth.id, booth]))
      for (const block of hall.page.blocks ?? []) {
        const path = new Path2D()
        for (const id of block.boothIds) {
          const booth = booths.get(id)
          if (!booth) throw new Error(`Block ${block.id} 缺少 Booth ${id}`)
          const b = booth.bbox
          path.rect(b.x, b.y, b.width, b.height)
        }
        backgrounds.set(block.id, path)
      }
      this.blockBackgrounds.set(hall, backgrounds)
    }
    const textPadding = 32 * Math.max(1, 1 / placement.aspectRatio)
    const page = view ? visibility.visiblePage(view, textPadding) : hall.page
    context.setLineDash([])
    const options: PreviewOptions = {
      background: false, boxes: display.boxes, numbers: display.numbers, halfBooths: false,
      islands: display.islands, groups: false, gaps: false, blockFrames: false, selectedIsland: null,
    }
    if (display.boxes && !filtered) {
      context.fillStyle = 'rgba(128, 128, 128, 0.18)'
      for (const block of page.blocks ?? []) {
        const path = backgrounds.get(block.id)
        if (!path) throw new Error(`Block ${block.id} 缺少背景几何`)
        context.fill(path)
      }
      if (occupancy && genreDisplay.enabled) {
        context.save()
        context.globalAlpha = 0.3
        for (const group of occupancy.genreRegions(hall)) {
          if (genreDisplay.selected && !genreDisplay.selected.has(group.key)) continue
          context.fillStyle = group.color
          context.fill(this.path(group.rectangles))
        }
        context.restore()
      }
      if (occupancy) {
        const regions = occupancy.vacancyRegions(hall)
        if (regions.length) {
          context.fillStyle = '#555555'
          context.fill(this.path(regions))
        }
      }
      if (hover) {
        context.fillStyle = 'rgba(255, 193, 7, 0.6)'
        context.fillRect(hover.x, hover.y, hover.width, hover.height)
      }
    }
    const textRotation = hallTextRotation(hall, placement.rotation + viewRotation)
    const drawText = (x: number, y: number, draw: () => void) => {
      if (filtered) return
      context.save()
      context.translate(x, y)
      // Cancel anisotropy around the label anchor, before its own text rotation.
      context.scale(1 / placement.aspectRatio, 1)
      context.translate(-x, -y)
      draw()
      context.restore()
    }
    for (const layer of this.layers) {
      context.save()
      layer.draw(context, { page, image: this.image, options, drawText,
        outlineColor: filtered ? filteredOutline : '#444444',
        numberColor: '#444444', numberBackground: false,
        numberRotation: () => textRotation })
      context.restore()
    }
    const drawMarker = (text: string, center: Point, fontSize: number, rotation = 0) => {
      if (view) {
        const radius = (text.length + 2) * fontSize * Math.max(1, 1 / placement.aspectRatio)
        if (!intersectsBounds(view, paddedBounds({
          minX: center.x, maxX: center.x, minY: center.y, maxY: center.y,
        }, radius))) return
      }
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.font = `bold ${fontSize}px "Yu Gothic", "Noto Sans JP", sans-serif`
      drawText(center.x, center.y, () => {
        context.translate(center.x, center.y)
        context.rotate(rotation * Math.PI / 180)
        context.fillStyle = markerColor
        context.fillText(text, 0, 0)
      })
    }
    if (display.islands && !filtered) {
      for (const marker of hall.page.islandMarkers ?? []) {
        drawMarker(marker.label ?? '?', marker.center, 20, textRotation)
      }
    }
    if (display.labels && !filtered) {
      for (const label of hall.labels) {
        drawMarker(label.text ?? label.code ?? '?', label.center, 22, textRotation)
      }
    }
    context.restore()
  }
}
