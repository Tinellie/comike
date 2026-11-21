export function whitenPdfColors(pixels: Uint8ClampedArray): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
    const max = Math.max(r, g, b)
    const chroma = max - Math.min(r, g, b)
    if (!chroma) continue
    // Ignore small channel differences from compression in otherwise gray ink.
    const gray = chroma >= 8 && chroma >= max * 0.06
      ? 255
      : Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    pixels[i] = pixels[i + 1] = pixels[i + 2] = gray
  }
}

export function preprocessPdfBackground(image: HTMLImageElement, removeWestGuideLines = false): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器不支持 PDF 背景预处理')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const { width, height, left, right, bands } = westLineCleanup
  if (removeWestGuideLines && canvas.width === width && canvas.height === height) {
    for (const { top, bottom, sample } of bands) {
      for (let y = top; y < bottom; y++) {
        pixels.data.copyWithin((y * width + left) * 4, (sample * width + left) * 4, (sample * width + right) * 4)
      }
    }
  }
  whitenPdfColors(pixels.data)
  context.putImageData(pixels, 0, 0)
  return canvas
}
import westLineCleanup from '../../../tools/booth-recognition/map_recognition/west_line_cleanup.json'
