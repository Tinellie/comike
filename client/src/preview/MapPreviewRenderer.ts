import type { PreviewPage } from './data'
import { BackgroundLayer, NumberLayer, IslandLayer } from './layers'
import { BlockLayer } from './BlockLayer'
import { BlockFrameLayer, blockFrameMargin } from './BlockFrameLayer'
import { AssignmentLayer, NumberGapLayer } from './assignmentLayers'
import { HalfBoothLayer } from './HalfBoothLayer'
import { HallOutlineLayer } from './HallOutlineLayer'
import type { CanvasLayer, PreviewOptions } from './layers'
import { previewSurface } from './pdfPreview'

export function previewMargin(page: PreviewPage, options: PreviewOptions): number {
  const markerMargin = options.islands
    ? Math.max(0, ...(page.islandMarkers ?? []).filter(marker => marker.bbox === null)
      .map(marker => Math.ceil(38 - marker.center.y)))
    : 0
  return Math.max(blockFrameMargin(page, options), markerMargin, options.hallOutline && page.hallOutline ? 2 : 0)
}

export class MapPreviewRenderer {
  private readonly context: CanvasRenderingContext2D
  private readonly layers: CanvasLayer[]
  private readonly canvas: HTMLCanvasElement

  constructor(
    canvas: HTMLCanvasElement,
    layers: CanvasLayer[] = [
      new BackgroundLayer(), new AssignmentLayer(), new BlockLayer(), new BlockFrameLayer(),
      new NumberLayer(), new HalfBoothLayer(), new IslandLayer(), new NumberGapLayer(),
      new HallOutlineLayer(),
    ],
  ) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持 Canvas 2D')
    this.context = context
    this.layers = layers
    this.canvas = canvas
  }

  draw(page: PreviewPage, image: HTMLImageElement, options: PreviewOptions, displayWidth: number) {
    const margin = previewMargin(page, options)
    const surface = previewSurface(page, margin)
    const viewWidth = surface.width
    const viewHeight = surface.height
    const displayHeight = displayWidth * viewHeight / viewWidth
    const ratio = window.devicePixelRatio || 1
    this.canvas.width = Math.round(displayWidth * ratio)
    this.canvas.height = Math.round(displayHeight * ratio)
    this.canvas.style.width = `${displayWidth}px`
    this.canvas.style.height = `${displayHeight}px`
    const scaleX = this.canvas.width / viewWidth
    const scaleY = this.canvas.height / viewHeight
    this.context.setTransform(scaleX, 0, 0, scaleY, -surface.x * scaleX, -surface.y * scaleY)
    this.context.fillStyle = '#ffffff'
    this.context.fillRect(surface.x, surface.y, viewWidth, viewHeight)
    if (page.pdfPreview) this.context.transform(...page.pdfPreview.transform)
    for (const layer of this.layers) {
      this.context.save()
      layer.draw(this.context, { page, image, options })
      this.context.restore()
    }
  }

  dispose() {
    this.context.resetTransform()
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.canvas.width = 0
    this.canvas.height = 0
  }
}
