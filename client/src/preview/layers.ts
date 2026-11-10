import { statusColors } from './data'
import type { PreviewPage } from './data'

export interface PreviewOptions {
  background: boolean
  boxes: boolean
  numbers: boolean
}

export interface DrawingScene {
  page: PreviewPage
  image: HTMLImageElement
  options: PreviewOptions
}

export interface CanvasLayer {
  draw(context: CanvasRenderingContext2D, scene: DrawingScene): void
}

export class BackgroundLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, image, options }: DrawingScene) {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, page.width, page.height)
    if (options.background) context.drawImage(image, 0, 0, page.width, page.height)
  }
}

export class BoothLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, options }: DrawingScene) {
    if (!options.boxes) return
    context.lineWidth = 2
    for (const booth of page.booths) {
      const { x, y, width, height } = booth.bbox
      context.strokeStyle = statusColors[booth.status]
      context.strokeRect(x + 1, y + 1, width - 2, height - 2)
    }
  }
}

export class NumberLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, options }: DrawingScene) {
    if (!options.numbers) return
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const booth of page.booths) {
      const { x, y, width, height } = booth.bbox
      const sideways = booth.rotation % 180 !== 0
      const labelWidth = sideways ? height : width
      const labelHeight = sideways ? width : height
      const fontSize = Math.max(8, Math.min(labelHeight * 0.6, labelWidth * 0.55))
      context.save()
      context.translate(x + width / 2, y + height / 2)
      // OCR stores correction CCW; place labels in the original image's orientation.
      context.rotate(booth.rotation * Math.PI / 180)
      context.font = `bold ${fontSize}px sans-serif`
      const text = booth.number ?? '?'
      const textWidth = context.measureText(text).width
      context.fillStyle = 'rgba(255,255,255,0.94)'
      context.fillRect(-textWidth / 2 - 2, -fontSize / 2 - 2, textWidth + 4, fontSize + 4)
      context.fillStyle = statusColors[booth.status]
      context.fillText(text, 0, 0)
      context.restore()
    }
  }
}
