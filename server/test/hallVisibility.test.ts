import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHalls } from '../../client/src/map/halls.ts'
import { HallVisibility, intersectsBounds } from '../../client/src/map/hallVisibility.ts'

function fixture() {
  return parseHalls({ halls: [{
    name: 'East', textRotation: 0, boundary: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 200 }, { x: 0, y: 200 }],
    islands: [0, 1].map(island => ({
      id: `i${island}`, code: 'A', markers: [],
      blocks: [0, 1].map(block => ({
        id: `b${island}-${block}`,
        bbox: { x: island * 300 + block * 80, y: 40, width: 40, height: 20 },
        booths: [0, 1].map(cell => ({
          id: `c${island}-${block}-${cell}`, number: '01',
          bbox: { x: island * 300 + block * 80 + cell * 20, y: 40, width: 20, height: 20 },
          split: { a: 'l', b: 'r' },
        })),
      })),
    })),
  }] })[0].page
}

test('visibility skips disjoint islands and blocks, then selects Booths and both halves without mutation', () => {
  const page = fixture(), before = structuredClone(page), index = new HallVisibility(page)
  const visible = index.visiblePage({ minX: 1, maxX: 19, minY: 41, maxY: 59 }, 0)
  assert.deepEqual(visible.blocks?.map(b => b.id), ['b0-0'])
  assert.deepEqual(visible.booths.map(b => b.id), ['c0-0-0'])
  assert.equal(visible.halfBooths?.length, 2)
  assert.equal(visible.halfBooths?.[0], page.halfBooths?.[0])
  assert.deepEqual(page, before)
  const empty = index.visiblePage({ minX: 500, maxX: 550, minY: 40, maxY: 60 }, 0)
  assert.equal(empty.booths.length, 0)
  assert.equal(empty.blocks?.length, 0)
  assert.equal(empty.halfBooths?.length, 0)
})

test('half-booth hit testing follows Island, Block, Booth and half bounds including shared edges', () => {
  const page = fixture(), before = structuredClone(page), index = new HallVisibility(page)
  assert.equal(index.hitTest({ x: -1, y: 50 }), null)
  assert.equal(index.hitTest({ x: 60, y: 50 }), null)
  const left = index.hitTest({ x: 5, y: 50 })
  assert.equal(left?.block.id, 'b0-0')
  assert.equal(left?.booth.id, 'c0-0-0')
  assert.equal(left?.half.suffix, 'a')
  assert.equal(index.hitTest({ x: 15, y: 50 })?.half.suffix, 'b')
  assert.equal(index.hitTest({ x: 10, y: 50 })?.half.suffix, 'b')
  assert.equal(index.hitTest({ x: 20, y: 50 })?.booth.id, 'c0-0-1')
  assert.equal(index.hitTest({ x: 305, y: 50 })?.block.islandId, 'i1')
  assert.deepEqual(page, before)
})

test('half-booth hit testing respects vertical splits and does not invent missing halves', () => {
  const page = fixture(), booth = page.booths[0]
  page.halfBooths = [0, 1].map(i => ({
    id: `${booth.id}-h${i + 1}`, boothId: booth.id, suffix: i === 0 ? 'a' : 'b',
    bbox: { ...booth.bbox, y: booth.bbox.y + i * 10, height: 10 },
    status: 'resolved', issues: [],
  }))
  const index = new HallVisibility(page)
  assert.equal(index.hitTest({ x: 5, y: 45 })?.half.suffix, 'a')
  assert.equal(index.hitTest({ x: 5, y: 55 })?.half.suffix, 'b')
  assert.equal(index.hitTest({ x: 25, y: 45 }), null)
})

test('fully contained subtrees avoid child checks, full scene reuses the original page', () => {
  const page = fixture(), index = new HallVisibility(page)
  assert.equal(index.visiblePage({ minX: -10, maxX: 600, minY: 0, maxY: 200 }, 0), page)
  const island = index.visiblePage({ minX: -1, maxX: 121, minY: 39, maxY: 61 }, 0)
  assert.deepEqual(island.blocks?.map(b => b.id), ['b0-0', 'b0-1'])
  assert.equal(island.booths.length, 4)
  assert.equal(island.halfBooths?.length, 8)
})

test('overlap includes edge contact, enclosing objects and text/line padding', () => {
  const outer = { minX: 0, maxX: 100, minY: 0, maxY: 100 }
  assert.equal(intersectsBounds(outer, { minX: 100, maxX: 120, minY: 10, maxY: 20 }), true)
  assert.equal(intersectsBounds(outer, { minX: 40, maxX: 50, minY: 40, maxY: 50 }), true)
  assert.equal(intersectsBounds(outer, { minX: 101, maxX: 120, minY: 10, maxY: 20 }), false)
  const index = new HallVisibility(fixture())
  const view = { minX: 42, maxX: 50, minY: 40, maxY: 60 }
  assert.equal(index.visiblePage(view, 0).booths.length, 0)
  assert.deepEqual(index.visiblePage(view, 3).booths.map(b => b.id), ['c0-0-1'])
})

test('cached grouping preserves source Block order across interleaved islands and empty/legacy scenes', () => {
  const page = fixture()
  const blocks = page.blocks!
  page.blocks = [blocks[0], blocks[2], blocks[1], blocks[3]]
  const index = new HallVisibility(page)
  const visible = index.visiblePage({ minX: -1, maxX: 350, minY: 39, maxY: 61 }, 0)
  assert.deepEqual(visible.blocks?.map(b => b.id), ['b0-0', 'b1-0', 'b0-1'])
  const empty = { ...page, blocks: [], booths: [], halfBooths: [] }
  assert.equal(new HallVisibility(empty).visiblePage({ minX: 0, maxX: 1, minY: 0, maxY: 1 }, 0), empty)
  const legacy = { ...page, blocks: null }
  assert.equal(new HallVisibility(legacy).visiblePage({ minX: 0, maxX: 1, minY: 0, maxY: 1 }, 0), legacy)
})
