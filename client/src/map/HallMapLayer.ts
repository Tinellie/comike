import { BlockLayer } from '../preview/BlockLayer'
import { HalfBoothLayer } from '../preview/HalfBoothLayer'
import { NumberLayer } from '../preview/layers'
import type { CanvasLayer, PreviewOptions } from '../preview/layers'
import type { Point } from './viewport'
import type { HallPlacement, MapHall } from './halls'
import { hallMatrix, object } from './halls'
import hallMetaSource from '../../../ref/hall-meta.json?raw'

const hallMeta = object(JSON.parse(hallMetaSource))
if (!Array.isArray(hallMeta.halls)) throw new Error('Hall marker 元数据列表无效')
const markerColors = hallMeta.halls.map(value => {
  const entry = object(value)
  if (typeof entry.name !== 'string' || !entry.name
    || typeof entry.code !== 'string' || !/^[EWSN]$/.test(entry.code)
    || typeof entry['marker-color'] !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry['marker-color'])) {
    throw new Error('Hall marker 名称、编号或颜色无效')
  }
  return { name: entry.name, code: entry.code, color: entry['marker-color'] }
})

export function hallMarkerColor(hall: MapHall): string {
  const codes = new Set(hall.labels.flatMap(label => label.code ? [label.code[0]] : []))
  const matches = markerColors.filter(entry => codes.size > 0
    ? codes.has(entry.code) : hall.name?.startsWith(entry.name))
  if (matches.length !== 1) throw new Error(`Hall ${hall.name ?? hall.index + 1} 缺少唯一 marker-color 配置`)
  return matches[0].color
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
  visible: true, boxes: true, numbers: true, halfBooths: true, islands: true, labels: true,
}

export class HallMapLayer {
  private readonly layers: CanvasLayer[] = [
    new BlockLayer(), new NumberLayer(), new HalfBoothLayer(),
  ]
  private readonly image = new Image()

  draw(
    context: CanvasRenderingContext2D, hall: MapHall, placement: HallPlacement,
    origin: Point, display: HallDisplay, selected: boolean,
  ) {
    if (!display.visible || !hall.page.hallOutline) return
    const markerColor = hallMarkerColor(hall)
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
    const drawMarker = (text: string, center: Point, fontSize: number, rotation = 0) => {
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
    if (display.islands) {
      const rotation = -Math.round(placement.rotation / 90) * 90
      for (const marker of hall.page.islandMarkers ?? []) {
        drawMarker(marker.label ?? '?', marker.center, 20, rotation)
      }
    }
    if (display.labels) {
      for (const label of hall.labels) {
        drawMarker(label.text ?? label.code ?? '?', label.center, 22)
      }
    }
    context.restore()
  }
}
