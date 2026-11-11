import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HallLabelLayer, parseHallLabels } from '../../client/src/preview/hallLabels.ts'
import { parsePreviewData } from '../../client/src/preview/data.ts'
import type { DrawingScene } from '../../client/src/preview/layers.ts'

function label() {
  return {
    id: 'p001-hall-001', text: '西2 / W2', label: '西2', code: 'W2',
    bbox: { x: 10, y: 20, width: 40, height: 30 }, center: { x: 30, y: 35 },
    recognitionScore: 0.99, rotation: 270, status: 'recognized', issues: [],
  }
}

test('Hall labels parse exact source bounds and legacy absence', () => {
  assert.equal(parseHallLabels(undefined, 100, 80), null)
  assert.deepEqual(parseHallLabels([label()], 100, 80), [label()])
  for (const value of [
    null, {}, [label(), label()], [{ ...label(), code: 'A2' }], [{ ...label(), label: '東2' }],
    [{ ...label(), bbox: { x: 90, y: 20, width: 40, height: 30 } }],
    [{ ...label(), center: { x: 31, y: 35 } }], [{ ...label(), recognitionScore: NaN }],
    [{ ...label(), rotation: 45 }], [{ ...label(), text: null }], [{ ...label(), status: 'not_run' }],
  ]) assert.throws(() => parseHallLabels(value, 100, 80), /场馆标签/)
  assert.equal(parseHallLabels([{
    ...label(), code: null, label: null, text: '西2/E2', status: 'needs_review', issues: ['conflicting_labels'],
  }], 100, 80)?.[0].code, null)
})

test('Hall labels are independent from page venue, remain in source coordinates, and can hide', () => {
  const page = parsePreviewData({
    schemaVersion: 1, coordinateSystem: { origin: 'top-left', unit: 'source-image-pixel' },
    pages: [{ page: 1, width: 100, height: 80, image: 'page-001.png', booths: [], hallLabels: [label()] }],
  })[0]
  assert.equal(page.venue, null)
  assert.deepEqual(page.hallLabels?.[0].center, { x: 30, y: 35 })
  const calls: unknown[] = []
  const context = {
    lineWidth: 0, textAlign: 'center' as const, textBaseline: 'middle' as const, font: '', strokeStyle: '', fillStyle: '',
    strokeRect: (...args: number[]) => calls.push(['box', ...args]),
    fillRect: (...args: number[]) => calls.push(['background', ...args]),
    fillText: (text: string, x: number, y: number) => calls.push([text, x, y]),
    measureText: () => ({ width: 80 }),
  }
  const scene: DrawingScene = {
    page, image: {} as HTMLImageElement,
    options: {
      background: false, boxes: false, blockFrames: false, numbers: false, islands: false,
      groups: false, gaps: false, halfBooths: false, hallLabels: true, selectedIsland: 'some-island',
    },
  }
  new HallLabelLayer().draw(context, scene)
  assert.deepEqual(calls[0], ['box', 9, 19, 42, 32])
  assert.deepEqual(calls.at(-1), ['西2/W2', 30, 35])
  calls.length = 0
  scene.options.hallLabels = false
  new HallLabelLayer().draw(context, scene)
  assert.equal(calls.length, 0)
})
