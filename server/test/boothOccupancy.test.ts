import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoothOccupancy, boothHover } from '../../client/src/map/boothOccupancy.ts'
import { HallVisibility } from '../../client/src/map/hallVisibility.ts'
import { parseHalls } from '../../client/src/map/halls.ts'

function fixture(split = { a: 'l', b: 'r' }) {
  const hall = parseHalls({ halls: [{
    name: '東123', textRotation: 0,
    boundary: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    islands: [{ id: 'i1', code: 'メ', markers: [], blocks: [{
      id: 'b1', bbox: { x: 0, y: 0, width: 20, height: 20 },
      booths: [{ id: 'c1', number: '10', bbox: { x: 0, y: 0, width: 20, height: 20 }, split }],
    }] }],
  }] })[0]
  return new HallVisibility(hall.page)
}

test('ab hover uses the full cell for either half; ordinary and unloaded cells use only the hit half', () => {
  const index = fixture()
  const occupancy = new BoothOccupancy({ merged: { 'メ': ['10'] }, vacancies: {} })
  for (const x of [5, 15]) {
    const hit = index.hitTest({ x, y: 5 })!
    assert.deepEqual(boothHover(hit, 'メ', occupancy), { bbox: hit.booth.bbox, suffix: 'ab' })
    assert.deepEqual(boothHover(hit, 'モ', occupancy), { bbox: hit.half.bbox, suffix: hit.half.suffix })
    assert.deepEqual(boothHover(hit, 'メ', null), { bbox: hit.half.bbox, suffix: hit.half.suffix })
  }
  const vertical = fixture({ a: 't', b: 'b' })
  for (const y of [5, 15]) {
    const hit = vertical.hitTest({ x: 5, y })!
    assert.equal(boothHover(hit, 'メ', occupancy).bbox, hit.booth.bbox)
  }
})

test('occupancy lookup preserves case and kana, normalizes width and numbers, and switches days without stale entries', () => {
  const occupancy = new BoothOccupancy({
    merged: { A: ['01'], 'あ': ['02'] }, vacancies: { A: ['01a', '02a', '02b'], a: ['03b'] },
  })
  assert.equal(occupancy.isMerged('Ａ', '1'), true)
  assert.equal(occupancy.isMerged('a', '01'), false)
  assert.equal(occupancy.isMerged('ア', '02'), false)
  assert.equal(occupancy.isVacant('Ａ', '1', 'a'), true)
  assert.equal(occupancy.isVacant('A', '1', 'b'), false)
  assert.equal(occupancy.isVacant('A', '2', 'a'), true)
  assert.equal(occupancy.isVacant('A', '2', 'b'), true)
  assert.equal(occupancy.isVacant('a', '3', 'b'), true)
  const nextDay = new BoothOccupancy({ merged: {}, vacancies: {} })
  assert.equal(nextDay.isMerged('A', '01'), false)
  assert.equal(nextDay.isVacant('A', '01', 'a'), false)
})
