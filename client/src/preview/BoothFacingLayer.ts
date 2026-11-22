import type { CanvasLayer, DrawingScene } from './layers'

export const facingColors = { wall: '#cc1872', aisle: '#176847', unknown: '#99500c' }

export class BoothFacingLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, options, facings }: DrawingScene) {
    if (!options.boothFacing || !facings) return
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (const booth of page.booths) {
      if (options.selectedIsland !== null && booth.islandId !== options.selectedIsland) continue
      const facing = facings.get(booth.id)
      if (!facing) continue
      const { x, y, width, height } = booth.bbox
      const cx = x + width / 2, cy = y + height / 2
      const radius = Math.min(width, height)
      const color = facing.wall ? facingColors.wall : facingColors.aisle
      const direction = facing.direction
      context.beginPath()
      if (!direction) {
        context.arc(cx, cy, radius * 0.11, 0, Math.PI * 2)
        context.fillStyle = facing.wall ? color : facingColors.unknown
        context.fill()
        continue
      }
      const { x: dx, y: dy } = direction
      const length = (dx ? width : height) * 0.34
      const head = radius * 0.16
      const tipX = cx + length * dx, tipY = cy + length * dy
      context.moveTo(cx - length * dx, cy - length * dy)
      context.lineTo(tipX, tipY)
      context.moveTo(tipX - head * (dx + dy), tipY - head * (dy - dx))
      context.lineTo(tipX, tipY)
      context.lineTo(tipX - head * (dx - dy), tipY - head * (dy + dx))
      context.strokeStyle = '#fff'
      context.lineWidth = radius * 0.22
      context.stroke()
      context.strokeStyle = color
      context.lineWidth = radius * 0.12
      context.stroke()
    }
  }
}
