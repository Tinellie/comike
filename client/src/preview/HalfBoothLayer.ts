import type { DrawingScene } from './layers'
import { drawSceneText } from './layers'

export class HalfBoothLayer {
  draw(context: Pick<CanvasRenderingContext2D,
    'lineWidth' | 'strokeStyle' | 'fillStyle' | 'font' | 'textAlign' | 'textBaseline'
    | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'setLineDash' | 'fillText'>,
  scene: Pick<DrawingScene, 'page' | 'options' | 'drawText'>) {
    const { page, options } = scene
    if (!options.halfBooths || page.halfBooths === null) return
    const parents = new Map(page.booths.map(b => [b.id, b]))
    context.lineWidth = 0.9
    context.setLineDash([])
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const half of page.halfBooths) {
      const parent = parents.get(half.boothId)
      if (!parent || (options.selectedIsland !== null && parent.islandId !== options.selectedIsland)) continue
      const b = half.bbox
      const color = half.status === 'resolved' && parent.status !== 'needs_review' ? '#006d77' : '#e08000'
      if (half.id.endsWith('-h1')) {
        const vertical = b.width < parent.bbox.width
        context.strokeStyle = color
        context.beginPath()
        context.moveTo(
          vertical ? b.x + b.width : b.x,
          vertical ? b.y : b.y + b.height,
        )
        context.lineTo(
          vertical ? b.x + b.width : b.x + b.width - 1,
          vertical ? b.y + b.height - 1 : b.y + b.height,
        )
        context.stroke()
      }
      const text = half.suffix ?? '?'
      const fontSize = Math.max(4, Math.min(10, b.height * 0.5, b.width / Math.max(1, text.length) * 1.4))
      context.font = `bold ${fontSize}px sans-serif`
      context.fillStyle = color
      drawSceneText(scene, b.x + b.width / 2, b.y + b.height / 2, () => {
        context.fillText(text, b.x + b.width / 2, b.y + b.height / 2)
      })
    }
  }
}
