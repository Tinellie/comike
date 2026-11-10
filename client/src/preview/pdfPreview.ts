export type PdfTransform = [number, number, number, number, number, number]

export interface PdfPreview {
  image: string
  width: number
  height: number
  transform: PdfTransform
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function transformPoint(transform: PdfTransform, x: number, y: number) {
  const [a, b, c, d, e, f] = transform
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

export function inverseTransform(transform: PdfTransform): PdfTransform {
  const [a, b, c, d, e, f] = transform
  const determinant = a * d - b * c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('PDF 地图变换不可逆')
  }
  return [d / determinant, -b / determinant, -c / determinant, a / determinant,
    (c * f - d * e) / determinant, (b * e - a * f) / determinant]
}

export function parsePdfPreview(value: unknown, page: number): PdfPreview | null {
  if (value === undefined) return null
  if (!record(value) || value.image !== `page-${String(page).padStart(3, '0')}-pdf.png`
    || !finite(value.width) || !Number.isSafeInteger(value.width) || value.width <= 0
    || !finite(value.height) || !Number.isSafeInteger(value.height) || value.height <= 0
    || !Array.isArray(value.transform) || value.transform.length !== 6) {
    throw new Error('PDF 完整页面元数据无效')
  }
  const [a, b, c, d, e, f] = value.transform
  if (!finite(a) || !finite(b) || !finite(c) || !finite(d) || !finite(e) || !finite(f)) {
    throw new Error('PDF 地图变换包含无效坐标')
  }
  const transform: PdfTransform = [a, b, c, d, e, f]
  inverseTransform(transform)
  return { image: value.image, width: value.width, height: value.height, transform }
}

export function previewSurface(
  page: { width: number; height: number; pdfPreview?: PdfPreview | null }, margin: number,
) {
  const pdf = page.pdfPreview
  if (!pdf) {
    return { width: page.width + margin * 2, height: page.height + margin * 2, x: -margin, y: -margin }
  }
  const corners = [
    transformPoint(pdf.transform, -margin, -margin),
    transformPoint(pdf.transform, page.width + margin, -margin),
    transformPoint(pdf.transform, page.width + margin, page.height + margin),
    transformPoint(pdf.transform, -margin, page.height + margin),
  ]
  const x = Math.min(0, ...corners.map(point => point.x))
  const y = Math.min(0, ...corners.map(point => point.y))
  return {
    x, y,
    width: Math.max(pdf.width, ...corners.map(point => point.x)) - x,
    height: Math.max(pdf.height, ...corners.map(point => point.y)) - y,
  }
}