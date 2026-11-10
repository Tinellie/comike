import type { PreviewBooth, PreviewPage } from './data'
import type { CanvasLayer, DrawingScene } from './layers'

export interface NumberGapAnnotation {
  booth: PreviewBooth
  label: string
  missingFirst: string
  missingLast: string
  islandId: string
}

export function numberGapAnnotations(page: PreviewPage): NumberGapAnnotation[] {
  if (!page.islandAssignment) return []
  const byId = new Map(page.booths.map(booth => [booth.id, booth]))
  return page.islandAssignment.islands.flatMap(island => island.numberGaps.map(gap => {
    const following = String(Number(gap.last) + 1).padStart(2, '0')
    const booth = island.boothIds.map(id => byId.get(id)).find(booth => booth?.number === following)
    if (!booth) throw new Error('缺号断点没有对应的后续 Booth')
    return { booth, label: following, missingFirst: gap.first, missingLast: gap.last, islandId: island.id }
  }))
}

export class AssignmentLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, options }: DrawingScene) {
    if (!options.groups || !page.islandAssignment) return
    const colors = new Map(page.islandAssignment.islands.map(island => [island.id, island.color]))
    for (const booth of page.booths) {
      if (booth.islandId === null) continue
      if (options.selectedIsland !== null && booth.islandId !== options.selectedIsland) continue
      const { x, y, width, height } = booth.bbox
      const color = colors.get(booth.islandId)
      if (!color) throw new Error('Booth 引用了不存在的 Island')
      context.globalAlpha = options.selectedIsland === null ? 0.25 : 0.5
      context.fillStyle = color
      context.fillRect(x, y, width, height)
    }
    context.globalAlpha = 1
  }
}

function overlaps(a: PreviewBooth['bbox'], b: PreviewBooth['bbox']): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export function numberGapLabelBox(
  page: PreviewPage, box: PreviewBooth['bbox'], width: number, height: number,
): PreviewBooth['bbox'] {
  const candidates = [
    { x: box.x + box.width + 8, y: box.y },
    { x: box.x, y: box.y - height - 8 },
    { x: box.x, y: box.y + box.height + 8 },
    { x: box.x - width - 8, y: box.y },
  ].map(position => ({
    x: Math.max(0, Math.min(position.x, page.width - width)),
    y: Math.max(0, Math.min(position.y, page.height - height)),
    width, height,
  })).filter(label => !overlaps(label, box))
  if (!candidates.length) throw new Error('地图空间不足，无法在 Booth 外绘制缺号标注')
  const collisions = (label: PreviewBooth['bbox']) => page.booths.filter(booth => overlaps(label, booth.bbox)).length
  return candidates.reduce((best, item) => collisions(item) < collisions(best) ? item : best)
}

export class NumberGapLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, options }: DrawingScene) {
    if (!options.gaps || !page.islandAssignment) return
    context.font = 'bold 18px sans-serif'
    context.textAlign = 'left'
    context.textBaseline = 'top'
    context.setLineDash([])
    context.lineWidth = 2
    for (const annotation of numberGapAnnotations(page)) {
      if (options.selectedIsland !== null && options.selectedIsland !== annotation.islandId) continue
      const box = annotation.booth.bbox
      const text = annotation.label
      const width = Math.ceil(context.measureText(text).width) + 8
      const height = 24
      const label = numberGapLabelBox(page, box, width, height)
      context.strokeStyle = '#bf360c'
      context.beginPath()
      context.moveTo(
        Math.max(box.x, Math.min(label.x + width / 2, box.x + box.width)),
        Math.max(box.y, Math.min(label.y + height / 2, box.y + box.height)),
      )
      context.lineTo(label.x + width / 2, label.y + height / 2)
      context.stroke()
      context.fillStyle = '#fff3e0'
      context.fillRect(label.x, label.y, width, height)
      context.strokeRect(label.x, label.y, width, height)
      context.fillStyle = '#bf360c'
      context.fillText(text, label.x + 4, label.y + 3)
    }
  }
}
