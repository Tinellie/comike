import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoothOccupancy, boothHover } from '../../client/src/map/boothOccupancy.ts'
import { HallVisibility } from '../../client/src/map/hallVisibility.ts'
import { parseHalls } from '../../client/src/map/halls.ts'
import { mergeVacancyRegions } from '../src/booths/regions.js'
import type { MapBoothData } from '../../client/src/booths/api.ts'

const emptyRegions = { vacancyRegions: [], genres: [], genreRegions: [], vacancyReady: false, genreReady: false }
const occupancy = (data: Pick<MapBoothData, 'merged' | 'vacancies'> & Partial<MapBoothData>) => new BoothOccupancy({ ...emptyRegions, ...data })

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
  const occupancy = new BoothOccupancy({ ...emptyRegions, merged: { 'メ': ['10'] }, vacancies: {} })
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

test('vacant halves suppress hover without changing hit detection or the occupied half', () => {
  const index = fixture()
  const occupancy = new BoothOccupancy({ ...emptyRegions, merged: {}, vacancies: { 'メ': ['10a'] } })
  const left = index.hitTest({ x: 5, y: 5 })!, right = index.hitTest({ x: 15, y: 5 })!
  assert.deepEqual(boothHover(left, 'メ', occupancy), { bbox: null, suffix: 'a' })
  assert.deepEqual(boothHover(right, 'メ', occupancy), { bbox: right.half.bbox, suffix: 'b' })
  assert.equal(left.booth.number, '10')
})

test('vacancy regions unite touching and overlapping rectangles without filling gaps or mutating input', () => {
  const box = (x: number, y: number, width = 10, height = 10) => ({ x, y, width, height })
  const rectangle = [box(0, 0), box(10, 0), box(0, 10), box(10, 10)]
  const before = structuredClone(rectangle)
  assert.deepEqual(mergeVacancyRegions(rectangle), [box(0, 0, 20, 20)])
  assert.deepEqual(rectangle, before)
  assert.deepEqual(mergeVacancyRegions([box(0, 0), box(9, 0), box(0, 0)]), [box(0, 0, 19, 10)])
  assert.deepEqual(mergeVacancyRegions([box(0, 0, 10.5), box(10.5, 0, 10.5)]), [box(0, 0, 21)])
  assert.equal(mergeVacancyRegions([box(0, 0), box(11, 0)]).length, 2)
  assert.equal(mergeVacancyRegions([box(0, 0), box(10, 10)]).length, 2)
  const ring = [box(0, 0, 30), box(0, 10), box(20, 10), box(0, 20, 30)]
  const regions = mergeVacancyRegions(ring)
  assert.equal(regions.reduce((area, b) => area + b.width * b.height, 0), 800)
  assert.ok(regions.every(b => !(b.x < 15 && b.x + b.width > 15 && b.y < 15 && b.y + b.height > 15)))
  assert.deepEqual(mergeVacancyRegions([]), [])
})

test('vacancy geometry consumes saved rectangles without computing from half booths', () => {
  const hall = parseHalls({ halls: [{
    name: '東123', textRotation: 0,
    boundary: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
    islands: [{ id: 'i1', code: 'メ', markers: [], blocks: [{
      id: 'b1', bbox: { x: 0, y: 0, width: 20, height: 20 },
      booths: [{ id: 'c1', number: '10', bbox: { x: 0, y: 0, width: 20, height: 20 }, split: { a: 'l', b: 'r' } }],
    }] }],
  }] })[0]
  const saved = [{ x: 0, y: 0, width: 20, height: 20 }]
  const data = occupancy({ merged: {}, vacancies: { 'メ': ['10a', '10b'] },
    vacancyRegions: [{ hallGroup: '東123', rectangles: saved }] })
  const regions = data.vacancyRegions(hall)
  assert.deepEqual(regions, [{ x: 0, y: 0, width: 20, height: 20 }])
  assert.equal(regions, saved)
  assert.equal(data.vacancyRegions(hall), regions)
  assert.deepEqual(occupancy({ merged: {}, vacancies: {} }).vacancyRegions(hall), [])
})

test('occupancy lookup preserves case and kana, normalizes width and numbers, and switches days without stale entries', () => {
  const occupancy = new BoothOccupancy({ ...emptyRegions,
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
  const nextDay = new BoothOccupancy({ ...emptyRegions, merged: {}, vacancies: {} })
  assert.equal(nextDay.isMerged('A', '01'), false)
  assert.equal(nextDay.isVacant('A', '01', 'a'), false)
})
