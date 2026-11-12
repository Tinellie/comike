import { BlockLayer } from '../preview/BlockLayer'
import { HalfBoothLayer } from '../preview/HalfBoothLayer'
import { IslandLayer, NumberLayer } from '../preview/layers'
import type { CanvasLayer, PreviewOptions } from '../preview/layers'
import type { Point } from './viewport'
import type { HallPlacement, MapHall } from './halls'
import { hallMatrix } from './halls'

export interface HallDisplay {
  visible: boolean
  boxes: boolean
  numbers: boolean
  halfBooths: boolean
  islands: boolean
  labels: boolean
}

export const defaultHallDisplay: HallDisplay = {
  visible: true, boxes: true, numbers: true, halfBooths: true, islands: true, labels: true,
}

export class HallMapLayer {
  private readonly layers: CanvasLayer[] = [
    new BlockLayer(), new NumberLayer(), new HalfBoothLayer(), new IslandLayer(),
  ]
  private readonly image = new Image()

  draw(
    context: CanvasRenderingContext2D, hall: MapHall, placement: HallPlacement,
    origin: Point, display: HallDisplay, selected: boolean,
  ) {
    if (!display.visible || !hall.page.hallOutline) return
    const [a, b, c, d, e, f] = hallMatrix(hall, placement)
    context.save()
    context.transform(a, b, c, d, e - origin.x, f - origin.y)
    context.setLineDash([])
    context.beginPath()
    const [first, ...rest] = hall.page.hallOutline.polygon
    context.moveTo(first.x, first.y)
    for (const point of rest) context.lineTo(point.x, point.y)
    context.closePath()
    context.strokeStyle = selected ? '#f07800' : '#d32f2f'
    context.lineWidth = selected ? 6 : 3
    context.stroke()
    const options: PreviewOptions = {
      background: false, boxes: display.boxes, numbers: display.numbers, halfBooths: display.halfBooths,
      islands: display.islands, groups: false, gaps: false, blockFrames: false, selectedIsland: null,
    }
    const drawText = (x: number, y: number, draw: () => void) => {
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
      layer.draw(context, { page: hall.page, image: this.image, options, drawText })
      context.restore()
    }
    if (display.labels) {
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.font = 'bold 22px "Yu Gothic", "Noto Sans JP", sans-serif'
      for (const label of hall.labels) {
        const text = label.text ?? label.code ?? '?'
        const width = context.measureText(text).width + 8
        drawText(label.center.x, label.center.y, () => {
          context.fillStyle = 'rgba(255,255,255,0.96)'
          context.fillRect(label.center.x - width / 2, label.center.y - 14, width, 28)
          context.fillStyle = '#006d91'
          context.fillText(text, label.center.x, label.center.y)
        })
      }
    }
    context.restore()
  }
}
