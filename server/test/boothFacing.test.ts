import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inferBoothFacings } from '../../client/src/preview/boothFacing.ts'
import type { PreviewBooth, PreviewPage } from '../../client/src/preview/data.ts'
import type { PathSegment } from '../../client/src/preview/pathGraph.ts'

function booth(id: string, x: number, y: number, islandId: string | null = null): PreviewBooth {
  return { id, bbox: { x, y, width: 10, height: 10 }, islandId, number: null,
    rotation: 0, status: 'recognized', assignment: null, blockId: null }
}

function infer(booths: PreviewBooth[], paths: PathSegment[] = [], horizontal = new Set<string>(),
  outline?: NonNullable<PreviewPage['hallOutline']>, venue?: string) {
  return inferBoothFacings({
    booths,
    halfBooths: booths.map(({ id, bbox }) => ({
      id: `${id}-h1`, boothId: id, suffix: 'a', status: 'resolved', issues: [],
      bbox: { ...bbox, width: horizontal.has(id) ? 10 : 5, height: horizontal.has(id) ? 5 : 10 },
    })),
    hallOutline: outline ?? {
      method: 'closed_frame',
      bbox: { x: 0, y: 0, width: 101, height: 101 },
      polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    },
    venue: venue ? { label: venue, rawText: null, recognitionScore: null, status: 'recognized', issues: [] } : null,
    pdfPreview: { image: 'p.png', width: 300, height: 300, transform: [2, 0, 0, 2, 10, 20] },
  }, paths)
}

test('south hall crop setbacks allow a single wall row with compatible corner directions', () => {
  const outline = {
    method: 'nonwhite_bbox',
    bbox: { x: 0, y: 0, width: 101, height: 101 },
    polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
  } as const
  const south = '\u535712'
  const row = [booth('corner', 8, 21, 'a'), booth('top', 40, 21, 'a')]
  assert.deepEqual([...infer(row, [], new Set(), outline, south).values()], [
    { wall: true, direction: { x: 0, y: 1 } },
    { wall: true, direction: { x: 0, y: 1 } },
  ])
  assert.ok([...infer(row, [], new Set(), outline).values()].every(item => !item.wall))
  const stacked = [booth('outer', 40, 8, 'a'), row[1]]
  assert.ok([...infer(stacked, [], new Set(), outline, south).values()].every(item => !item.wall))
})

test('west hall single rows set back from the recess face inward from their nearest edge', () => {
  const outline = {
    method: 'layout_notch',
    bbox: { x: 0, y: 0, width: 201, height: 201 },
    polygon: [[0, 0], [200, 0], [200, 65], [65, 65], [65, 135], [200, 135], [200, 200], [0, 200]]
      .map(([x, y]) => ({ x, y })),
  } as const
  const row = [booth('upper', 120, 32, 'a'), booth('inner', 35, 95, 'a'), booth('lower', 120, 162, 'a')]
  const horizontal = new Set(['inner'])
  const directions = infer(row, [], horizontal, outline)
  assert.deepEqual([...directions.values()], [
    { wall: true, direction: { x: 0, y: -1 } },
    { wall: true, direction: { x: -1, y: 0 } },
    { wall: true, direction: { x: 0, y: 1 } },
  ])
  for (const extra of [booth('second-row', 120, 45, 'a'), booth('outer-setback', 16, 50, 'a')]) {
    assert.ok([...infer([...row, extra], [], horizontal, outline).values()].every(item => !item.wall))
  }
})

test('one island can follow the wall around a corner, facing inward along each split', () => {
  const directions = infer([booth('top', 20, 2, 'a'), booth('left', 2, 30, 'a')], [], new Set(['left']))
  assert.deepEqual(directions.get('top'), { wall: true, direction: { x: 0, y: 1 } })
  assert.deepEqual(directions.get('left'), { wall: true, direction: { x: 1, y: 0 } })
})

test('an interior member or a second row disqualifies the whole island from wall status', () => {
  for (const y of [12, 45]) {
    const directions = infer([booth('outer', 20, 2, 'a'), booth('inner', 20, y, 'a')])
    assert.ok([...directions.values()].every(item => !item.wall))
  }
})

test('aisles use PDF registration and do not count through touching booths', () => {
  const paths: PathSegment[] = [[60, 100, 140, 100], [60, 180, 140, 180]]
  const target = booth('target', 30, 50)
  assert.equal(infer([target], paths).get('target')?.direction, null)
  assert.equal(infer([target], []).get('target')?.direction, null)
  const directions = infer([target, booth('back', 30, 40)], paths)
  assert.deepEqual(directions.get('target'), { wall: false, direction: { x: 0, y: 1 } })
})
