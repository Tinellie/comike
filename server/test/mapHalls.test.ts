import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHalls, parseHallTransforms, hallMatrix, hallWorldBounds } from '../../client/src/map/halls.ts'
import { projectCoordinate, worldToScreen, fitViewport } from '../../client/src/map/viewport.ts'
import { validHallTransforms } from '../src/hallTransforms.ts'

function finalData() {
  return { halls: [{
    name: 'East',
    boundary: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 100 }, { x: 10, y: 100 }],
    labels: [{ id: 'label1', text: '東1/E1', code: 'E1', pos: { x: 40, y: 30 } }],
    islands: [{
      id: 'i1', code: 'A', markers: [{ id: 'm1', pos: { x: 20, y: 30 } }],
      blocks: [{
        id: 'block1', bbox: { x: 20, y: 40, width: 41, height: 21 }, grid: { rows: 1, columns: 2 },
        booths: [
          { id: 'b1', number: '01', bbox: { x: 20, y: 40, width: 21, height: 21 }, split: { a: 'r', b: 'l' } },
          { id: 'b2', number: '02', bbox: { x: 40, y: 40, width: 21, height: 21 }, split: { a: 't', b: 'b' } },
        ],
      }],
    }],
  }] }
}

function transforms() {
  return {
    schemaVersion: 1,
    placements: [{
      hallIndex: 0, name: 'East', anchor: { latitude: 35.63, longitude: 139.79 },
      offset: { x: 20, y: -30 }, rotation: 90, scale: 0.1,
    }],
  }
}

test('final adapter retains all geometry, matrix borders, half letters, centers, and no diagnostic layers', () => {
  const source = finalData(), before = structuredClone(source)
  const [hall] = parseHalls(source), page = hall.page
  assert.deepEqual(source, before)
  assert.deepEqual(hall.pivot, { x: 60, y: 60 })
  assert.equal(page.blocks?.[0].outline.length, 4)
  assert.equal(page.blocks?.[0].dividers.length, 1)
  assert.deepEqual(page.halfBooths?.map(h => h.suffix), ['b', 'a', 'a', 'b'])
  assert.deepEqual(page.halfBooths?.[0].bbox, { x: 20, y: 40, width: 10.5, height: 21 })
  assert.deepEqual(page.islandMarkers?.[0].center, { x: 20, y: 30 })
  assert.equal(page.islandMarkers?.[0].label, 'A')
  assert.deepEqual(hall.labels[0].center, { x: 40, y: 30 })
  assert.equal(page.islandAssignment, null)
  assert.equal(page.pdfPreview, undefined)
})

test('irregular block geometry and unknown split/labels are kept without inventing half letters', () => {
  const data = finalData()
  Reflect.deleteProperty(data.halls[0].islands[0].blocks[0], 'grid')
  Reflect.set(data.halls[0].islands[0].blocks[0].booths[0], 'split', null)
  Reflect.set(data.halls[0].islands[0], 'code', null)
  const [hall] = parseHalls(data)
  assert.equal(hall.page.halfBooths?.length, 2)
  assert.equal(hall.page.islandMarkers?.[0].label, null)
  assert.ok((hall.page.blocks?.[0].outline.length ?? 0) > 0)
})

test('invalid final structures and invalid/missing/duplicate/mismatched placements fail explicitly', () => {
  for (const bad of [null, {}, { halls: [] }, { halls: [{ name: 'Hall', boundary: [], islands: [] }] }]) {
    assert.throws(() => parseHalls(bad), /Hall/)
  }
  const halls = parseHalls(finalData())
  for (const change of [
    (v: ReturnType<typeof transforms>) => { v.placements = [] },
    (v: ReturnType<typeof transforms>) => { v.placements.push(v.placements[0]) },
    (v: ReturnType<typeof transforms>) => { v.placements[0].name = 'Wrong' },
    (v: ReturnType<typeof transforms>) => { v.placements[0].scale = 0 },
    (v: ReturnType<typeof transforms>) => { v.placements[0].anchor.latitude = 86 },
    (v: ReturnType<typeof transforms>) => { v.placements[0].offset.x = NaN },
    (v: ReturnType<typeof transforms>) => { v.placements[0].hallIndex = 0.5 },
  ]) {
    const config = transforms()
    change(config)
    assert.throws(() => parseHallTransforms(config, halls), /Hall/)
    assert.equal(validHallTransforms(config, ['East']), false)
  }
  assert.equal(validHallTransforms(transforms(), ['East']), true)
})

test('Hall transform rotates clockwise about center, uses ground meters, and fits transformed extents', () => {
  const [hall] = parseHalls(finalData())
  const placement = parseHallTransforms(transforms(), [hall]).placements[0]
  const [a, b, c, d, e, f] = hallMatrix(hall, placement)
  const transform = (x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + f })
  const anchor = projectCoordinate(placement.anchor.latitude, placement.anchor.longitude)
  const meters = Math.cos(placement.anchor.latitude * Math.PI / 180)
  const center = transform(hall.pivot.x, hall.pivot.y)
  assert.ok(Math.abs(center.x - anchor.x - 20 / meters) < 1e-8)
  assert.ok(Math.abs(center.y - anchor.y + 30 / meters) < 1e-8)
  const right = transform(hall.pivot.x + 100, hall.pivot.y)
  assert.ok(Math.abs(right.x - center.x) < 1e-8)
  assert.ok(Math.abs((right.y - center.y) * meters - 10) < 1e-8)
  const bounds = hallWorldBounds(hall, placement)
  const size = { width: 900, height: 600 }, view = fitViewport(bounds, size)
  const pixel = worldToScreen(center, view, size)
  assert.ok(Math.abs(pixel.x - 450) < 1e-6 && Math.abs(pixel.y - 300) < 1e-6)
})
