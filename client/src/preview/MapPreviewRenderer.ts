import type { PreviewPage } from './data'
import { BackgroundLayer, NumberLayer, IslandLayer } from './layers'
import { BlockLayer } from './BlockLayer'
import { BlockFrameLayer, blockFrameMargin } from './BlockFrameLayer'
import { AssignmentLayer, NumberGapLayer } from './assignmentLayers'
import { HalfBoothLayer } from './HalfBoothLayer'
import type { CanvasLayer, PreviewOptions } from './layers'

export function previewMargin(page: PreviewPage, options: PreviewOptions): number {
  const markerMargin = options.islands
    ? Math.max(0, ...(page.islandMarkers ?? []).filter(marker => marker.bbox === null)
      .map(marker => Math.ceil(38 - marker.center.y)))
    : 0
  return Math.max(blockFrameMargin(page, options), markerMargin)
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
    const viewWidth = page.width + margin * 2
    const viewHeight = page.height + margin * 2
    const displayHeight = displayWidth * viewHeight / viewWidth
    const ratio = window.devicePixelRatio || 1
    this.canvas.width = Math.round(displayWidth * ratio)
    this.canvas.height = Math.round(displayHeight * ratio)
    this.canvas.style.width = `${displayWidth}px`
    this.canvas.style.height = `${displayHeight}px`
    const scaleX = this.canvas.width / viewWidth
    const scaleY = this.canvas.height / viewHeight
    this.context.setTransform(scaleX, 0, 0, scaleY, margin * scaleX, margin * scaleY)
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
