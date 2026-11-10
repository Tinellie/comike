import type { CanvasLayer, DrawingScene } from './layers'

export class HallOutlineLayer implements CanvasLayer {
  draw(context: Pick<CanvasRenderingContext2D,
    'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'stroke' | 'strokeStyle' | 'lineWidth' | 'setLineDash'>,
  { page, options }: DrawingScene) {
    if (!options.hallOutline || !page.hallOutline) return
    const [first, ...rest] = page.hallOutline.polygon
    context.strokeStyle = '#d32f2f'
    context.lineWidth = 3
    context.setLineDash(page.hallOutline.method === 'closed_frame' ? [] : [10, 5])
    context.beginPath()
    context.moveTo(first.x, first.y)
    for (const point of rest) context.lineTo(point.x, point.y)
    context.closePath()
    context.stroke()
  }
}