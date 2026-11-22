import { statusColors } from './data'
import type { PreviewBooth, PreviewPage } from './data'
import { inverseTransform } from './pdfPreview'
import type { PathSegment } from './pathGraph'
import type { BoothFacing } from './boothFacing'

export interface PreviewOptions {
  background: boolean
  preprocessPdf?: boolean
  boxes: boolean
  blockFrames: boolean
  numbers: boolean
  islands: boolean
  groups: boolean
  gaps: boolean
  halfBooths: boolean
  hallOutline?: boolean
  hallLabels?: boolean
  pathGraph?: boolean
  boothFacing?: boolean
  selectedIsland: string | null
}

export interface DrawingScene {
  page: PreviewPage
  image: HTMLImageElement | HTMLCanvasElement
  options: PreviewOptions
  drawText?: (x: number, y: number, draw: () => void) => void
  outlineColor?: string
  numberRotation?: (booth: PreviewBooth) => number
  numberColor?: string
  numberBackground?: boolean
  paths?: PathSegment[] | null
  facings?: ReadonlyMap<string, BoothFacing> | null
}

export function drawSceneText(scene: Pick<DrawingScene, 'drawText'>, x: number, y: number, draw: () => void) {
  if (scene.drawText) scene.drawText(x, y, draw)
  else draw()
}

export interface CanvasLayer {
  draw(context: CanvasRenderingContext2D, scene: DrawingScene): void
}

export class BackgroundLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, image, options }: DrawingScene) {
    if (page.pdfPreview) {
      context.transform(...inverseTransform(page.pdfPreview.transform))
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, page.pdfPreview.width, page.pdfPreview.height)
      if (options.background) context.drawImage(image, 0, 0, page.pdfPreview.width, page.pdfPreview.height)
      return
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, page.width, page.height)
    if (options.background) context.drawImage(image, 0, 0, page.width, page.height)
  }
}

export class BoothLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, options, outlineColor }: DrawingScene) {
    if (!options.boxes) return
    context.lineWidth = 2
    for (const booth of page.booths) {
      const { x, y, width, height } = booth.bbox
      context.strokeStyle = outlineColor ?? statusColors[booth.status]
      context.strokeRect(x + 1, y + 1, width - 2, height - 2)
    }
  }
}

export class NumberLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, scene: DrawingScene) {
    const { page, options } = scene
    if (!options.numbers || (options.halfBooths && page.halfBooths !== null)) return
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const booth of page.booths) {
      const { x, y, width, height } = booth.bbox
      const sideways = booth.rotation % 180 !== 0
      const labelWidth = sideways ? height : width
      const labelHeight = sideways ? width : height
      const fontSize = Math.max(8, Math.min(labelHeight * 0.6, labelWidth * 0.55))
      drawSceneText(scene, x + width / 2, y + height / 2, () => {
        context.save()
        context.translate(x + width / 2, y + height / 2)
        // OCR stores correction CCW; place labels in the original image's orientation.
        context.rotate((scene.numberRotation?.(booth) ?? booth.rotation) * Math.PI / 180)
        context.font = `bold ${fontSize}px sans-serif`
        const text = booth.number ?? '?'
        if (scene.numberBackground !== false) {
          const textWidth = context.measureText(text).width
          context.fillStyle = 'rgba(255,255,255,0.94)'
          context.fillRect(-textWidth / 2 - 2, -fontSize / 2 - 2, textWidth + 4, fontSize + 4)
        }
        context.fillStyle = scene.numberColor ?? statusColors[booth.status]
        context.fillText(text, 0, 0)
        context.restore()
      })
    }
  }
}

export class IslandLayer implements CanvasLayer {
  draw(context: Pick<CanvasRenderingContext2D,
    'lineWidth' | 'textAlign' | 'textBaseline' | 'strokeStyle' | 'setLineDash' | 'strokeRect'
    | 'font' | 'fillStyle' | 'fillRect' | 'fillText' | 'beginPath' | 'arc' | 'fill'> & {
      measureText(text: string): Pick<TextMetrics, 'width'>
    }, scene: DrawingScene) {
    const { page, options } = scene
    if (!options.islands || !page.islandMarkers) return
    context.lineWidth = 2
    context.textAlign = 'left'
    context.textBaseline = 'top'
    for (const marker of page.islandMarkers) {
      const color = marker.status === 'recognized' ? '#8b35d1' : statusColors[marker.status]
      const inferred = marker.inference?.outcome === 'corrected' || marker.inference?.outcome === 'confirmed'
      const text = `${marker.label ?? '?'}${inferred ? '*' : ''}`
      if (marker.bbox === null) {
        const { x, y } = marker.center
        context.font = 'bold 20px "Yu Gothic", "Noto Sans JP", sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        const textWidth = context.measureText(text).width + 6
        drawSceneText(scene, x, y - 24, () => {
          context.fillStyle = 'rgba(255,255,255,0.96)'
          context.fillRect(x - textWidth / 2, y - 36, textWidth, 24)
          context.fillStyle = color
          context.fillText(text, x, y - 24)
        })
        context.fillStyle = color
        context.beginPath()
        context.arc(x, y, 2.5, 0, Math.PI * 2)
        context.fill()
        context.textAlign = 'left'
        context.textBaseline = 'top'
        continue
      }
      const { x, y, width, height } = marker.bbox
      context.strokeStyle = color
      context.setLineDash(marker.status === 'recognized' ? [] : [4, 3])
      context.strokeRect(x - 1, y - 1, width + 2, height + 2)
      const fontSize = Math.max(14, Math.min(24, Math.max(width, height) * 0.6))
      context.font = `bold ${fontSize}px "Yu Gothic", "Noto Sans JP", sans-serif`
      const textWidth = context.measureText(text).width + 6
      const left = Math.max(0, Math.min(x, page.width - textWidth))
      const top = y > fontSize + 6 ? y - fontSize - 6 : Math.min(page.height - fontSize - 4, y + height + 3)
      drawSceneText(scene, left + 3, top + 2, () => {
        context.fillStyle = 'rgba(255,255,255,0.96)'
        context.fillRect(left, top, textWidth, fontSize + 4)
        context.fillStyle = color
        context.fillText(text, left + 3, top + 2)
      })
    }
    context.setLineDash([])
  }
}
