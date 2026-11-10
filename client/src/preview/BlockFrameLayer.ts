import type { PreviewBlock, PreviewPage } from './data'
import type { CanvasLayer, DrawingScene, PreviewOptions } from './layers'

const frameOffset = 6
const frameLineWidth = 2

export function expandedBlockFrame(block: PreviewBlock) {
  const { x, y, width, height } = block.bbox
  return {
    x: x - frameOffset, y: y - frameOffset,
    width: width - 1 + frameOffset * 2, height: height - 1 + frameOffset * 2,
  }
}

export function blockFrameMargin(page: PreviewPage, options: PreviewOptions): number {
  return options.blockFrames && page.blocks !== null && page.blocks.length > 0
    ? frameOffset + frameLineWidth : 0
}

type FrameContext = Pick<CanvasRenderingContext2D, 'strokeStyle' | 'lineWidth' | 'setLineDash' | 'strokeRect'>

export class BlockFrameLayer implements CanvasLayer {
  draw(context: FrameContext, { page, options }: Pick<DrawingScene, 'page' | 'options'>) {
    if (!options.blockFrames || page.blocks === null) return
    context.strokeStyle = '#1565c0'
    context.lineWidth = frameLineWidth
    context.setLineDash([6, 4])
    for (const block of page.blocks) {
      if (options.selectedIsland !== null && block.islandId !== options.selectedIsland) continue
      const { x, y, width, height } = expandedBlockFrame(block)
      context.strokeRect(x, y, width, height)
    }
  }
}
