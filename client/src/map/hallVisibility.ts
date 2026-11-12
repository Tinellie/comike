import type { PreviewBlock, PreviewBooth, PreviewPage } from '../preview/data'
import type { PreviewHalfBooth } from '../preview/halfBooths'
import type { Bounds, Point } from './viewport'

export function intersectsBounds(left: Bounds, right: Bounds): boolean {
  return left.minX <= right.maxX && left.maxX >= right.minX
    && left.minY <= right.maxY && left.maxY >= right.minY
}

function containsBounds(outer: Bounds, inner: Bounds): boolean {
  return outer.minX <= inner.minX && outer.maxX >= inner.maxX
    && outer.minY <= inner.minY && outer.maxY >= inner.maxY
}

export function paddedBounds(bounds: Bounds, padding: number): Bounds {
  return { minX: bounds.minX - padding, minY: bounds.minY - padding,
    maxX: bounds.maxX + padding, maxY: bounds.maxY + padding }
}

function boxBounds(box: PreviewBooth['bbox']): Bounds {
  return { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height }
}

function unionBounds(bounds: Bounds[]): Bounds {
  return {
    minX: Math.min(...bounds.map(b => b.minX)), minY: Math.min(...bounds.map(b => b.minY)),
    maxX: Math.max(...bounds.map(b => b.maxX)), maxY: Math.max(...bounds.map(b => b.maxY)),
  }
}

interface BlockNode {
  order: number
  block: PreviewBlock
  bounds: Bounds
  booths: { booth: PreviewBooth; bounds: Bounds; halves: PreviewHalfBooth[] }[]
}

export class HallVisibility {
  private readonly islands: { bounds: Bounds; blocks: BlockNode[] }[]
  private readonly page: PreviewPage

  constructor(page: PreviewPage) {
    this.page = page
    const booths = new Map<string, PreviewBooth[]>()
    const halves = new Map<string, PreviewHalfBooth[]>()
    for (const booth of page.booths) {
      const key = booth.blockId
      if (key === null || key === undefined) continue
      const group = booths.get(key) ?? []
      group.push(booth)
      booths.set(key, group)
    }
    for (const half of page.halfBooths ?? []) {
      const group = halves.get(half.boothId) ?? []
      group.push(half)
      halves.set(half.boothId, group)
    }
    const islands = new Map<string | null, BlockNode[]>()
    for (const [order, block] of (page.blocks ?? []).entries()) {
      const group = islands.get(block.islandId) ?? []
      group.push({
        block, order, bounds: boxBounds(block.bbox),
        booths: (booths.get(block.id) ?? []).map(booth => ({
          booth, bounds: boxBounds(booth.bbox), halves: halves.get(booth.id) ?? [],
        })),
      })
      islands.set(block.islandId, group)
    }
    this.islands = [...islands.values()].map(blocks => ({
      bounds: unionBounds(blocks.map(block => block.bounds)), blocks,
    }))
  }

  hitTest(point: Point): { block: PreviewBlock; booth: PreviewBooth; half: PreviewHalfBooth } | null {
    const query = { minX: point.x, maxX: point.x, minY: point.y, maxY: point.y }
    let hit: { block: PreviewBlock; booth: PreviewBooth; half: PreviewHalfBooth } | null = null
    let order = -1
    for (const island of this.islands) {
      if (!intersectsBounds(query, island.bounds)) continue
      for (const node of island.blocks) {
        if (node.order < order || !intersectsBounds(query, node.bounds)) continue
        for (const cell of node.booths) {
          if (!intersectsBounds(query, cell.bounds)) continue
          for (const half of cell.halves) {
            if (!intersectsBounds(query, boxBounds(half.bbox))) continue
            hit = { block: node.block, booth: cell.booth, half }
            order = node.order
          }
        }
      }
    }
    return hit
  }

  visiblePage(view: Bounds, padding: number): PreviewPage {
    if (this.page.blocks === null) return this.page
    const query = paddedBounds(view, padding)
    if (this.islands.every(island => containsBounds(query, island.bounds))) return this.page
    const blocks: PreviewBlock[] = [], booths: PreviewBooth[] = [], halves: PreviewHalfBooth[] = []
    const visible: { node: BlockNode; complete: boolean }[] = []
    const append = (node: BlockNode, complete: boolean) => {
      blocks.push(node.block)
      for (const cell of node.booths) {
        if (!complete && !intersectsBounds(query, cell.bounds)) continue
        booths.push(cell.booth)
        halves.push(...cell.halves)
      }
    }
    for (const island of this.islands) {
      if (!intersectsBounds(query, island.bounds)) continue
      const complete = containsBounds(query, island.bounds)
      for (const node of island.blocks) {
        if (!complete && !intersectsBounds(query, node.bounds)) continue
        visible.push({ node, complete: complete || containsBounds(query, node.bounds) })
      }
    }
    visible.sort((a, b) => a.node.order - b.node.order)
    for (const { node, complete } of visible) append(node, complete)
    return { ...this.page, blocks, booths, halfBooths: this.page.halfBooths === null ? null : halves }
  }
}
