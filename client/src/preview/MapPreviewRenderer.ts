import type { PreviewPage } from './data'
import { BackgroundLayer, BoothLayer, NumberLayer, IslandLayer } from './layers'
import type { CanvasLayer, PreviewOptions } from './layers'

export class MapPreviewRenderer {
  private readonly context: CanvasRenderingContext2D
  private readonly layers: CanvasLayer[]
  private readonly canvas: HTMLCanvasElement

  constructor(
    canvas: HTMLCanvasElement,
    layers: CanvasLayer[] = [new BackgroundLayer(), new BoothLayer(), new NumberLayer(), new IslandLayer()],
  ) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持 Canvas 2D')
    this.context = context
    this.layers = layers
    this.canvas = canvas
  }

  draw(page: PreviewPage, image: HTMLImageElement, options: PreviewOptions, displayWidth: number) {
    const displayHeight = displayWidth * page.height / page.width
    const ratio = window.devicePixelRatio || 1
    this.canvas.width = Math.round(displayWidth * ratio)
    this.canvas.height = Math.round(displayHeight * ratio)
    this.canvas.style.width = `${displayWidth}px`
    this.canvas.style.height = `${displayHeight}px`
    this.context.setTransform(
      this.canvas.width / page.width, 0, 0, this.canvas.height / page.height, 0, 0,
    )
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
