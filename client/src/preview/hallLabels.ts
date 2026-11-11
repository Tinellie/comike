import type { CanvasLayer, DrawingScene } from './layers'

export interface PreviewHallLabel {
  id: string
  text: string | null
  label: string | null
  code: string | null
  bbox: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
  recognitionScore: number | null
  rotation: number
  status: 'recognized' | 'needs_review' | 'not_run'
  issues: string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export function parseHallLabels(value: unknown, width: number, height: number): PreviewHallLabel[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) throw new Error('场馆标签列表格式无效')
  const ids = new Set<string>()
  return value.map((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || !record(item.bbox) || !record(item.center)
      || ![0, 90, 180, 270].some(rotation => rotation === item.rotation)
      || (item.status !== 'recognized' && item.status !== 'needs_review' && item.status !== 'not_run')
      || !Array.isArray(item.issues) || !item.issues.every((issue: unknown) => typeof issue === 'string')) {
      throw new Error('场馆标签格式无效')
    }
    const { x, y, width: w, height: h } = item.bbox
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0
      || typeof y !== 'number' || !Number.isSafeInteger(y) || y < 0
      || typeof w !== 'number' || !Number.isSafeInteger(w) || w <= 0
      || typeof h !== 'number' || !Number.isSafeInteger(h) || h <= 0
      || x + w > width || y + h > height
      || item.center.x !== x + w / 2 || item.center.y !== y + h / 2) {
      throw new Error('场馆标签位置无效')
    }
    const code = item.code
    const names: Record<string, string> = { E: '東', W: '西', S: '南', N: '北' }
    if (!(code === null || (typeof code === 'string' && /^[EWSN][1-9][0-9]?$/.test(code)))
      || !(item.label === null || typeof item.label === 'string')
      || item.label !== (code === null ? null : `${names[code[0]]}${code.slice(1)}`)
      || !(item.text === null || (typeof item.text === 'string' && item.text.length > 0))
      || !(item.recognitionScore === null || (typeof item.recognitionScore === 'number'
        && Number.isFinite(item.recognitionScore) && item.recognitionScore >= 0 && item.recognitionScore <= 1))
      || (item.status === 'not_run'
        ? code !== null || item.text !== null || item.recognitionScore !== null
        : item.text === null || item.recognitionScore === null)
      || (item.status === 'recognized' && (code === null || item.issues.length > 0))
      || (item.status === 'needs_review' && item.issues.length === 0)) {
      throw new Error('场馆标签识别记录无效')
    }
    ids.add(item.id)
    return {
      id: item.id, text: item.text, label: item.label, code,
      bbox: { x, y, width: w, height: h }, center: { x: x + w / 2, y: y + h / 2 },
      recognitionScore: item.recognitionScore, rotation: Number(item.rotation),
      status: item.status, issues: item.issues,
    }
  })
}

export class HallLabelLayer implements CanvasLayer {
  draw(context: Pick<CanvasRenderingContext2D,
    'lineWidth' | 'textAlign' | 'textBaseline' | 'font' | 'strokeStyle' | 'fillStyle'
    | 'strokeRect' | 'fillRect' | 'fillText'> & {
      measureText(text: string): Pick<TextMetrics, 'width'>
    }, { page, options }: DrawingScene) {
    if (!options.hallLabels || !page.hallLabels) return
    context.lineWidth = 2
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.font = 'bold 20px "Yu Gothic", "Noto Sans JP", sans-serif'
    for (const label of page.hallLabels) {
      const { x, y, width, height } = label.bbox
      const color = label.status === 'recognized' ? '#006d91' : '#e08000'
      context.strokeStyle = color
      context.strokeRect(x - 1, y - 1, width + 2, height + 2)
      const text = label.label && label.code ? `${label.label}/${label.code}` : label.text ?? '?'
      const textWidth = context.measureText(text).width + 8
      context.fillStyle = 'rgba(255,255,255,0.96)'
      context.fillRect(label.center.x - textWidth / 2, label.center.y - 13, textWidth, 26)
      context.fillStyle = color
      context.fillText(text, label.center.x, label.center.y)
    }
  }
}
