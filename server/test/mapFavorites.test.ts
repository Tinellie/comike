import assert from 'node:assert/strict'
import { test } from 'node:test'
import { favoriteHighlights } from '../../client/src/map/favoriteHighlights.ts'
import { parseHalls } from '../../client/src/map/halls.ts'
import type { MapFavorite } from '../../client/src/booths/api.ts'

function fixture() {
  return parseHalls({ halls: [
    { name: '東123', textRotation: 0,
      boundary: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }],
      islands: [{ id: 'i1', code: 'A', markers: [], blocks: [
        { id: 'block1', bbox: { x: 0, y: 0, width: 20, height: 20 }, booths: [
          { id: 'b1', number: '01', bbox: { x: 0, y: 0, width: 20, height: 20 }, split: { a: 'r', b: 'l' } },
        ] },
        { id: 'block2', bbox: { x: 20, y: 0, width: 20, height: 20 }, booths: [
          { id: 'b2', number: '02', bbox: { x: 20, y: 0, width: 20, height: 20 }, split: { a: 't', b: 'b' } },
        ] },
        { id: 'block3', bbox: { x: 40, y: 0, width: 20, height: 20 }, booths: [
          { id: 'b3', number: '03', bbox: { x: 40, y: 0, width: 20, height: 20 }, split: null },
        ] },
      ] }] },
    { name: '南12', textRotation: 90,
      boundary: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
      islands: [{ id: 'i2', code: 'a', markers: [], blocks: [
        { id: 'block4', bbox: { x: 0, y: 0, width: 20, height: 20 }, booths: [
          { id: 'b4', number: '01', bbox: { x: 0, y: 0, width: 20, height: 20 }, split: { a: 'l', b: 'r' } },
        ] },
      ] }] },
  ] })
}

function favorite(patch: Partial<MapFavorite> = {}): MapFavorite {
  return { boothId: '24001', hallGroup: '東123', island: 'A', number: '01', suffix: 'a', colour: '#FF0000', ...patch }
}

test('favorites map to exact reversed, vertical and full ab geometry without modifying map cells', () => {
  const halls = fixture()
  const before = structuredClone(halls)
  const result = favoriteHighlights(halls, [
    favorite(),
    favorite({ boothId: '24002', suffix: 'b', colour: '#0000FF' }),
    favorite({ boothId: '24003', number: '02', suffix: 'b' }),
    favorite({ boothId: '24004', number: '02', suffix: 'ab', colour: '#00B54A' }),
    favorite({ boothId: '24005', number: '03', suffix: 'ab', colour: '#FFFFFF' }),
  ])
  assert.equal(result.unmatched, 0)
  assert.deepEqual(result.stops.map(({ booth, bbox }) => [booth.id, bbox.x, bbox.y]), [
    ['b1', 10, 0], ['b1', 0, 0], ['b2', 20, 10], ['b2', 20, 0], ['b3', 40, 0],
  ])
  assert.deepEqual(result.byHall.get(0), [
    { colour: '#FF0000', rectangles: [{ x: 10, y: 0, width: 10, height: 20 }, { x: 20, y: 10, width: 20, height: 10 }] },
    { colour: '#0000FF', rectangles: [{ x: 0, y: 0, width: 10, height: 20 }] },
    { colour: '#00B54A', rectangles: [{ x: 20, y: 0, width: 20, height: 20 }] },
    { colour: '#FFFFFF', rectangles: [{ x: 40, y: 0, width: 20, height: 20 }] },
  ])
  assert.deepEqual(halls, before)
})

test('favorite locations preserve hall, Latin case and kana; normalize width/numbers and report unmappable halves', () => {
  const halls = fixture()
  const result = favoriteHighlights(halls, [
    favorite({ island: 'Ａ', number: '1' }),
    favorite({ hallGroup: '南12', island: 'a', number: '1', colour: '#00B54A' }),
    favorite({ island: 'a' }), favorite({ island: 'ア' }), favorite({ island: 'あ' }),
    favorite({ hallGroup: '東7' }), favorite({ number: '99' }), favorite({ suffix: null }),
    favorite({ suffix: '' }), favorite({ suffix: 'c' }), favorite({ number: '03' }),
  ])
  assert.equal(result.unmatched, 9)
  assert.deepEqual(result.byHall.get(0), [{ colour: '#FF0000', rectangles: [{ x: 10, y: 0, width: 10, height: 20 }] }])
  assert.deepEqual(result.byHall.get(1), [{ colour: '#00B54A', rectangles: [{ x: 0, y: 0, width: 10, height: 20 }] }])
  assert.equal(favoriteHighlights(halls, []).byHall.size, 0)
  assert.equal(favoriteHighlights([], [favorite()]).unmatched, 0)
  const next = favoriteHighlights(halls, [favorite({ colour: '#0000FF' })])
  assert.deepEqual(next.byHall.get(0)?.map(group => group.colour), ['#0000FF'])
  assert.equal(next.byHall.has(1), false)
})

test('ambiguous duplicate map locations are reported instead of painting an arbitrary cell', () => {
  const halls = fixture()
  halls[0]!.page.booths.push({ ...halls[0]!.page.booths[0]!, id: 'duplicate-location' })
  const result = favoriteHighlights(halls, [favorite()])
  assert.equal(result.unmatched, 1)
  assert.equal(result.byHall.size, 0)
})
