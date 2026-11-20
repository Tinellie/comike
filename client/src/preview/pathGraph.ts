import type { CanvasLayer, DrawingScene } from './layers'
import { inverseTransform } from './pdfPreview'

export type PathSegment = readonly [number, number, number, number]

export function parsePathGraph(value: unknown, width: number, height: number): PathSegment[] {
  if (!value || typeof value !== 'object' || !('width' in value) || value.width !== width
    || !('height' in value) || value.height !== height || !('segments' in value) || !Array.isArray(value.segments)) {
    throw new Error('路径图与 PDF 背景尺寸不一致，请重新生成')
  }
  return value.segments.map((segment: unknown) => {
    if (!Array.isArray(segment) || segment.length !== 4
      || !segment.every((point: unknown) => typeof point === 'number' && Number.isSafeInteger(point))) {
      throw new Error('路径图包含无效坐标')
    }
    const [x1, y1, x2, y2] = segment
    if (x1 < 0 || x1 >= width || x2 < 0 || x2 >= width || y1 < 0 || y1 >= height || y2 < 0 || y2 >= height
      || (x1 === x2) === (y1 === y2)) throw new Error('路径图包含越界或非水平垂直的线段')
    return [x1, y1, x2, y2]
  })
}

export class PathGraphLayer implements CanvasLayer {
  draw(context: CanvasRenderingContext2D, { page, options, paths }: DrawingScene) {
    if (!options.pathGraph || !page.pdfPreview || !paths?.length) return
    context.transform(...inverseTransform(page.pdfPreview.transform))
    context.beginPath()
    for (const [x1, y1, x2, y2] of paths) {
      context.moveTo(x1, y1)
      context.lineTo(x2, y2)
    }
    context.lineWidth = 3
    context.strokeStyle = '#0068db'
    context.stroke()
  }
}