import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inverseTransform, parsePdfPreview, previewSurface, transformPoint } from '../../client/src/preview/pdfPreview.ts'
import { parsePreviewData } from '../../client/src/preview/data.ts'
import { MapPreviewRenderer } from '../../client/src/preview/MapPreviewRenderer.ts'
import { BackgroundLayer } from '../../client/src/preview/layers.ts'
import { whitenPdfColors } from '../../client/src/preview/pdfBackground.ts'
import type { PdfTransform } from '../../client/src/preview/pdfPreview.ts'
import type { PreviewOptions } from '../../client/src/preview/layers.ts'

const pdf = { image: 'page-001-pdf.png', width: 400, height: 320, transform: [1, 0, 0, 1, 30, 40] }
const options: PreviewOptions = {
  background: true, boxes: false, blockFrames: false, numbers: false, islands: false,
  groups: false, gaps: false, halfBooths: false, selectedIsland: null,
}

test('PDF background whitening removes saturated ink, keeps black and gray, and neutralizes faint color noise', () => {
  const pixels = new Uint8ClampedArray([
    185, 29, 100, 255, 15, 70, 180, 255, 240, 225, 233, 255,
    0, 0, 0, 255, 125, 125, 125, 255, 255, 255, 255, 255, 128, 130, 129, 255,
  ])
  whitenPdfColors(pixels)
  assert.deepEqual([...pixels], [
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    0, 0, 0, 255, 125, 125, 125, 255, 255, 255, 255, 255, 130, 130, 130, 255,
  ])
})

test('full PDF metadata allows only the corresponding whitelisted page asset and invertible transform', () => {
  assert.equal(parsePdfPreview(undefined, 1), null)
  assert.deepEqual(parsePdfPreview(pdf, 1), pdf)
  for (const value of [
    null, {}, { ...pdf, image: 'page-002-pdf.png' }, { ...pdf, image: '../map.pdf' },
    { ...pdf, width: 0 }, { ...pdf, height: 12.5 }, { ...pdf, transform: [1, 2] },
    { ...pdf, transform: [1, 2, 2, 4, 0, 0] }, { ...pdf, transform: [1, 0, 0, 1, NaN, 0] },
  ]) {
    assert.throws(() => parsePdfPreview(value, 1), /PDF/)
  }
})

test('full page surface includes the PDF header and preserves legacy crop margins', () => {
  const page = { width: 100, height: 80, pdfPreview: parsePdfPreview(pdf, 1) }
  assert.deepEqual(previewSurface(page, 6), { x: 0, y: 0, width: 400, height: 320 })
  assert.deepEqual(previewSurface({ width: 100, height: 80 }, 6), { x: -6, y: -6, width: 112, height: 92 })
  const touching = { ...page, pdfPreview: parsePdfPreview({ ...pdf, transform: [1, 0, 0, 1, 0, 0] }, 1) }
  assert.deepEqual(previewSurface(touching, 6), { x: -6, y: -6, width: 406, height: 326 })
})

test('source to PDF mapping and inverse support rotation, scaling and padded source coordinates', () => {
  for (const transform of [
    [1, 0, 0, 1, 28, 198], [0, 2, -2, 0, 120, 30], [1.01, 0.1, 0.02, 0.99, 30, 40],
  ] satisfies PdfTransform[]) {
    const point = transformPoint(transform, 32, 54)
    const original = transformPoint(inverseTransform(transform), point.x, point.y)
    assert.ok(Math.abs(original.x - 32) < 1e-9)
    assert.ok(Math.abs(original.y - 54) < 1e-9)
  }
})

test('renderer draws the complete background and maps overlays exactly once into the PDF', () => {
  const page = parsePreviewData({
    schemaVersion: 1, coordinateSystem: { origin: 'top-left', unit: 'source-image-pixel' },
    pages: [{ page: 1, width: 100, height: 80, image: 'page-001.png', booths: [], pdfPreview: pdf }],
  })[0]
  const calls: unknown[] = []
  const context = {
    fillStyle: '', setTransform: (...values: number[]) => calls.push(['set', ...values]),
    transform: (...values: number[]) => calls.push(['transform', ...values]),
    fillRect: (...values: number[]) => calls.push(['fill', ...values]),
    drawImage: (...values: unknown[]) => calls.push(['image', ...values.slice(1)]),
    save: () => {}, restore: () => {},
  }
  const canvas = {
    width: 0, height: 0, style: { width: '', height: '' }, getContext: () => context,
  } as HTMLCanvasElement
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 2 } })
  try {
    const renderer = new MapPreviewRenderer(canvas, [
      new BackgroundLayer(),
      { draw: () => calls.push('overlay') },
    ])
    renderer.draw(page, {} as HTMLImageElement, options, 400)
    assert.equal(canvas.width, 800)
    assert.equal(canvas.height, 640)
    assert.deepEqual(calls, [
      ['set', 2, 0, 0, 2, -0, -0], ['fill', 0, 0, 400, 320],
      ['transform', 1, 0, 0, 1, 30, 40],
      ['transform', 1, -0, -0, 1, -30, -40], ['fill', 0, 0, 400, 320],
      ['image', 0, 0, 400, 320], 'overlay',
    ])
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})