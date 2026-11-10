import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHallOutline } from '../../client/src/preview/hallOutline.ts'
import { HallOutlineLayer } from '../../client/src/preview/HallOutlineLayer.ts'
import type { DrawingScene } from '../../client/src/preview/layers.ts'
import { parsePreviewData } from '../../client/src/preview/data.ts'

function outline() {
  return {
    method: 'nonwhite_bbox',
    polygon: [{ x: 0, y: 1 }, { x: 99, y: 1 }, { x: 99, y: 79 }, { x: 0, y: 79 }],
    bbox: { x: 0, y: 1, width: 100, height: 79 },
  }
}

test('Hall boundary supports legacy data and validates exact source pixel bounds', () => {
  assert.equal(parseHallOutline(undefined, 100, 80), null)
  assert.deepEqual(parseHallOutline(outline(), 100, 80), outline())
  for (const value of [
    null, {}, { ...outline(), method: 'guessed' },
    { ...outline(), polygon: [] },
    { ...outline(), polygon: [{ x: -1, y: 0 }, ...outline().polygon] },
    { ...outline(), polygon: [{ x: 100, y: 1 }, ...outline().polygon] },
    { ...outline(), bbox: { x: 0, y: 1, width: 99, height: 79 } },
    { ...outline(), polygon: [...outline().polygon].reverse() },
  ]) {
    assert.throws(() => parseHallOutline(value, 100, 80), /Hall/)
  }
})

test('Hall outline is wired into the Preview parser without changing old schemas', () => {
  const data = {
    schemaVersion: 1, coordinateSystem: { origin: 'top-left', unit: 'source-image-pixel' },
    pages: [{ page: 1, width: 100, height: 80, image: 'page-001.png', booths: [], hallOutline: outline() }],
  }
  assert.deepEqual(parsePreviewData(data)[0].hallOutline, outline())
})

test('Hall drawing closes the original polygon and distinguishes frame from fallback', () => {
  const calls: unknown[] = []
  const context = {
    strokeStyle: '', lineWidth: 0,
    setLineDash: (dash: number[]) => calls.push(dash),
    beginPath: () => calls.push('begin'),
    moveTo: (x: number, y: number) => calls.push(['move', x, y]),
    lineTo: (x: number, y: number) => calls.push(['line', x, y]),
    closePath: () => calls.push('close'),
    stroke: () => calls.push('stroke'),
  }
  const page = parsePreviewData({
    schemaVersion: 1, coordinateSystem: { origin: 'top-left', unit: 'source-image-pixel' },
    pages: [{ page: 1, width: 100, height: 80, image: 'page-001.png', booths: [], hallOutline: outline() }],
  })[0]
  const scene: DrawingScene = {
    page, image: {} as HTMLImageElement,
    options: {
      background: false, boxes: false, blockFrames: false, numbers: false, islands: false,
      groups: false, gaps: false, halfBooths: false, hallOutline: true, selectedIsland: null,
    },
  }
  const layer = new HallOutlineLayer()
  layer.draw(context, scene)
  assert.deepEqual(calls, [
    [10, 5], 'begin', ['move', 0, 1], ['line', 99, 1], ['line', 99, 79], ['line', 0, 79], 'close', 'stroke',
  ])
  assert.equal(context.strokeStyle, '#d32f2f')
  calls.length = 0
  scene.page.hallOutline = { ...parseHallOutline(outline(), 100, 80)!, method: 'closed_frame' }
  layer.draw(context, scene)
  assert.deepEqual(calls[0], [])
  calls.length = 0
  scene.options.hallOutline = false
  layer.draw(context, scene)
  assert.equal(calls.length, 0)
})