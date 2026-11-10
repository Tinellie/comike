import { statusColors } from './data'
import type { BoothStatus, PreviewBlock, PreviewBlockEdge } from './data'
import { BoothLayer } from './layers'
import type { CanvasLayer, DrawingScene } from './layers'

type BlockContext = Pick<CanvasRenderingContext2D,
  'lineWidth' | 'strokeStyle' | 'setLineDash' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke'>

export function drawBlockBorders(context: BlockContext, blocks: PreviewBlock[]) {
  context.lineWidth = 2
  context.setLineDash([])
  const drawEdges = (edges: PreviewBlockEdge[]) => {
    const batches = new Map<BoothStatus, PreviewBlockEdge[]>()
    for (const edge of edges) {
      const batch = batches.get(edge.status) ?? []
      batch.push(edge)
      batches.set(edge.status, batch)
    }
    for (const [status, batch] of batches) {
      context.beginPath()
      context.strokeStyle = statusColors[status]
      for (const edge of batch) {
        context.moveTo(edge.x1, edge.y1)
        context.lineTo(edge.x2, edge.y2)
      }
      context.stroke()
    }
  }
  drawEdges(blocks.flatMap(block => block.outline))
  drawEdges(blocks.flatMap(block => block.dividers))
}

export class BlockLayer implements CanvasLayer {
  private readonly legacy = new BoothLayer()

  draw(context: CanvasRenderingContext2D, scene: DrawingScene) {
    const { page, options } = scene
    if (!options.boxes) return
    if (page.blocks === null) {
      this.legacy.draw(context, scene)
      return
    }
    drawBlockBorders(context, page.blocks)
  }
}
