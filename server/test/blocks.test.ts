import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePreviewData } from '../../client/src/preview/data.ts'
import { drawBlockBorders } from '../../client/src/preview/BlockLayer.ts'
import { BlockFrameLayer, blockFrameMargin, expandedBlockFrame } from '../../client/src/preview/BlockFrameLayer.ts'
import type { PreviewOptions } from '../../client/src/preview/layers.ts'
import { blockGeometry, inferMatrixGrid } from '../../client/src/preview/blockGeometry.ts'
import { IslandLayer } from '../../client/src/preview/layers.ts'
import { previewMargin } from '../../client/src/preview/MapPreviewRenderer.ts'

function fixture() {
  const edge = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, status: 'recognized' })
  return {
    schemaVersion: 5,
    coordinateSystem: { origin: 'top-left', unit: 'source-image-pixel' },
    pages: [{
      page: 1, width: 200, height: 150, image: 'page-001.png', islandMarkers: [], excludedCandidates: [],
      booths: [[10, 10], [29, 10], [10, 39], [29, 39]].map(([x, y], i) => ({
        id: `b${i}`, bbox: { x, y, width: 20, height: 30 }, number: `0${i+1}`,
        rotation: 0, status: 'recognized', blockId: 'g1',
      })),
      blockGrouping: {
        method: 'pixel-edge-connected-components', maxBorderPixelDistance: 1,
        counts: { blocks: 1, booths: 4, excludedCandidates: 0 },
        blocks: [{
          id: 'g1', boothIds: ['b0', 'b1', 'b2', 'b3'], bbox: { x: 10, y: 10, width: 39, height: 59 },
          outline: [edge(10, 10, 48, 10), edge(10, 68, 48, 68), edge(10, 10, 10, 68), edge(48, 10, 48, 68)],
          dividers: [edge(29, 10, 29, 68), edge(10, 39, 48, 39)],
        }],
      },
    }],
  }
}

function assignedFixture() {
  const base = fixture()
  return {
    ...base,
    pages: base.pages.map(page => ({
      ...page,
      booths: page.booths.map(booth => ({
        ...booth, islandId: 's1',
        assignment: { islandId: 's1', componentId: 'g1', status: 'assigned', issues: [] },
      })),
      islandMarkers: [{
        id: 'm1', bbox: { x: 80, y: 10, width: 20, height: 24 },
        color: '#1177cc', label: 'A', status: 'recognized', recognitionScore: 0.99, issues: [],
      }],
      blockGrouping: { ...page.blockGrouping, blocks: page.blockGrouping.blocks.map(b => ({ ...b, islandId: 's1' })) },
      islandAssignment: {
        solverStatus: 'optimal',
        counts: { assignedBooths: 4, islands: 1, contactComponents: 1, excludedCandidates: 0, reviewBooths: 0, numberGaps: 0 },
        constraints: { allBoothsAssigned: true, touchingBoothsTogether: true, uniqueNumbers: true, continuousNumbers: true },
        components: [{ id: 'g1', boothIds: page.booths.map(b => b.id) }],
        islands: [{
          id: 's1', label: 'A', color: '#1177cc', markerIds: ['m1'], boothIds: page.booths.map(b => b.id),
          componentIds: ['g1'], numbers: ['01', '02', '03', '04'], numberRange: { first: '01', last: '04' },
          numberGaps: [], status: 'assigned', issues: [],
        }],
      },
    })),
  }
}

function compactFixture(assigned = true) {
  const legacy = assignedFixture()
  return {
    ...legacy, schemaVersion: 6,
    pages: legacy.pages.map(page => ({
      ...page,
      booths: page.booths.map(({ islandId: _, assignment: __, blockId: ___, ...booth }) => booth),
      blocks: page.blockGrouping.blocks.map(({ outline: _, dividers: __, islandId: ___, ...block }) => ({
        ...block, grid: { rows: 2, columns: 2 }, axis: 'horizontal', thin: false,
      })),
      blockGrouping: {
        method: page.blockGrouping.method, maxBorderPixelDistance: 1, counts: page.blockGrouping.counts,
      },
      islands: assigned ? page.islandAssignment.islands.map(({ boothIds: _, componentIds, ...island }) => ({
        ...island, blockIds: componentIds,
      })) : [],
      islandAssignment: assigned ? {
        solverStatus: page.islandAssignment.solverStatus, counts: page.islandAssignment.counts,
        constraints: page.islandAssignment.constraints, assignmentReviews: {} as Record<string, string[]>,
      } : undefined,
    })),
  }
}

function centeredFixture(assigned = true) {
  const data = compactFixture(assigned)
  return {
    ...data, schemaVersion: 7,
    pages: data.pages.map(page => ({
      ...page,
      islands: page.islands.map(island => ({ ...island, layoutKind: 'interior' })),
      islandMarkers: page.islandMarkers.map(({ bbox, ...marker }) => ({
        ...marker, center: { x: bbox.x + (bbox.width - 1) / 2, y: bbox.y + (bbox.height - 1) / 2 },
      })),
      markerAlignment: {
        method: 'local-center-lines', status: assigned ? 'aligned' : 'centers_only',
        counts: { markers: 1, aligned: 0, centered: 0, interior: assigned ? 1 : 0 },
      },
    })),
  }
}

test('schema 7 reads center-only markers without recreating OCR boxes or changing source data', () => {
  const data = centeredFixture()
  const before = JSON.stringify(data)
  const page = parsePreviewData(data)[0]
  assert.equal(page.islandMarkers?.[0].bbox, null)
  assert.deepEqual(page.islandMarkers?.[0].center, { x: 89.5, y: 21.5 })
  assert.equal(page.markerAlignment?.status, 'aligned')
  assert.equal(page.booths.length, 4)
  assert.equal(JSON.stringify(data), before)
  assert.equal(parsePreviewData(centeredFixture(false))[0].markerAlignment?.status, 'centers_only')
  const legacy = parsePreviewData(compactFixture())[0]
  assert.ok(legacy.islandMarkers?.[0].bbox)
  assert.deepEqual(legacy.islandMarkers?.[0].center, page.islandMarkers?.[0].center)
})

test('schema 7 rejects missing, nonfinite, out-of-bounds or redundant marker geometry and bad stage counts', () => {
  for (const mutate of [
    (d: ReturnType<typeof centeredFixture>) => { d.pages[0].islandMarkers[0].center.x = NaN },
    (d: ReturnType<typeof centeredFixture>) => { d.pages[0].islandMarkers[0].center.x = 200 },
    (d: ReturnType<typeof centeredFixture>) => { d.pages[0].islandMarkers[0].center.y = -1 },
    (d: ReturnType<typeof centeredFixture>) => { Object.assign(d.pages[0].islandMarkers[0], { bbox: { x: 80, y: 10, width: 20, height: 24 } }) },
    (d: ReturnType<typeof centeredFixture>) => { Object.assign(d.pages[0].islandMarkers[0], { center: null }) },
    (d: ReturnType<typeof centeredFixture>) => { d.pages[0].markerAlignment.counts.markers = 2 },
    (d: ReturnType<typeof centeredFixture>) => { d.pages[0].markerAlignment.counts.centered = 1 },
    (d: ReturnType<typeof centeredFixture>) => { d.pages[0].markerAlignment.status = 'centers_only' },
    (d: ReturnType<typeof centeredFixture>) => { d.pages[0].islands[0].layoutKind = 'other' },
    (d: ReturnType<typeof centeredFixture>) => { d.pages[0].markerAlignment.counts.interior = 9 },
  ]) {
    const data = centeredFixture()
    mutate(data)
    assert.throws(() => parsePreviewData(data))
  }
})

test('center-only Island drawing raises text and draws a single dot at the unchanged center', () => {
  const page = parsePreviewData(centeredFixture())[0]
  const before = JSON.stringify(page)
  const text: [string, number, number][] = []
  const dots: number[][] = []
  let fills = 0
  let boxes = 0
  const context = {
    lineWidth: 0, textAlign: 'left' as const, textBaseline: 'top' as const,
    strokeStyle: '', fillStyle: '', font: '',
    setLineDash() {},
    strokeRect() { boxes++ },
    measureText() { return { width: 16 } },
    fillRect() {},
    fillText(value: string, x: number, y: number) { text.push([value, x, y]) },
    beginPath() {},
    arc(x: number, y: number, radius: number, start: number, end: number) { dots.push([x, y, radius, start, end]) },
    fill() { fills++ },
  }
  new IslandLayer().draw(context, { page, options: { ...frameOptions(), islands: true } })
  assert.equal(boxes, 0)
  assert.deepEqual(text, [['A', 89.5, -2.5]])
  assert.deepEqual(dots, [[89.5, 21.5, 2.5, 0, Math.PI * 2]])
  assert.equal(fills, 1)
  assert.equal(JSON.stringify(page), before)
  new IslandLayer().draw(context, { page, options: frameOptions() })
  assert.equal(fills, 1)
})

test('raised marker labels get enough canvas margin without changing source-pixel zoom', () => {
  const page = parsePreviewData(centeredFixture())[0]
  const options = { ...frameOptions(), islands: true }
  const margin = previewMargin(page, options)
  assert.equal(margin, 17)
  assert.ok(page.islandMarkers![0].center.y - 36 + margin >= 0)
  assert.equal(previewMargin(page, frameOptions()), blockFrameMargin(page, frameOptions()))
  assert.equal(previewMargin(parsePreviewData(compactFixture())[0], options), 8)
})

test('schema 6 reconstructs runtime indices and matrix lines from only Island -> Block -> Booth mappings', () => {
  const data = compactFixture()
  const before = JSON.stringify(data)
  const page = parsePreviewData(data)[0]
  const legacy = parsePreviewData(assignedFixture())[0]
  assert.deepEqual(page.booths, legacy.booths)
  assert.deepEqual(page.islandAssignment, legacy.islandAssignment)
  assert.deepEqual(page.blocks?.[0].outline, legacy.blocks?.[0].outline)
  assert.deepEqual(page.blocks?.[0].dividers, [...(legacy.blocks?.[0].dividers ?? [])].reverse())
  assert.equal(JSON.stringify(data), before)
  const noAssignment = parsePreviewData(compactFixture(false))[0]
  assert.equal(noAssignment.islandAssignment, null)
  assert.equal(noAssignment.blocks?.length, 1)
  assert.ok(noAssignment.booths.every(b => b.blockId === 'g1' && b.islandId === null))
  data.pages[0].islandAssignment!.assignmentReviews.b1 = ['global_constraint_choice']
  data.pages[0].islandAssignment!.counts.reviewBooths = 1
  assert.equal(parsePreviewData(data)[0].booths[1].assignment?.status, 'needs_review')
  assert.deepEqual(parsePreviewData(data)[0].booths[1].assignment?.issues, ['global_constraint_choice'])
})

test('schema 6 rejects conflicting matrix sizes, incomplete ancestry and repeated reverse mappings', () => {
  for (const mutate of [
    (d: ReturnType<typeof compactFixture>) => { d.pages[0].blocks[0].grid.rows = 3 },
    (d: ReturnType<typeof compactFixture>) => { d.pages[0].blocks[0].boothIds.pop() },
    (d: ReturnType<typeof compactFixture>) => { d.pages[0].islands[0].blockIds.push('g1') },
    (d: ReturnType<typeof compactFixture>) => { d.pages[0].islands[0].blockIds[0] = 'missing' },
    (d: ReturnType<typeof compactFixture>) => { d.pages[0].islands = [] },
    (d: ReturnType<typeof compactFixture>) => { d.pages[0].islandAssignment!.assignmentReviews.missing = ['review'] },
    (d: ReturnType<typeof compactFixture>) => { Object.assign(d.pages[0].booths[0], { islandId: 's1' }) },
    (d: ReturnType<typeof compactFixture>) => { Object.assign(d.pages[0].blocks[0], { outline: [] }) },
    (d: ReturnType<typeof compactFixture>) => { Object.assign(d.pages[0].islands[0], { boothIds: [] }) },
    (d: ReturnType<typeof compactFixture>) => { Object.assign(d.pages[0].islandAssignment, { components: [] }) },
  ]) {
    const data = compactFixture()
    mutate(data)
    assert.throws(() => parsePreviewData(data))
  }
})

test('matrix geometry uses boundary/count spacing while irregular shapes preserve missing cells and shared edges', () => {
  const cells = fixture().pages[0].booths.map(b => ({ bbox: b.bbox, status: 'recognized' as const }))
  const bbox = { x: 10, y: 10, width: 39, height: 59 }
  assert.deepEqual(inferMatrixGrid(cells), { rows: 2, columns: 2 })
  const matrix = blockGeometry(cells, bbox, inferMatrixGrid(cells))
  assert.equal(matrix.outline.length, 4)
  assert.deepEqual(matrix.dividers, [
    { x1: 10, y1: 39, x2: 48, y2: 39, status: 'recognized' },
    { x1: 29, y1: 10, x2: 29, y2: 68, status: 'recognized' },
  ])
  const lShape = cells.slice(0, 3)
  assert.equal(inferMatrixGrid(lShape), null)
  assert.equal(blockGeometry(lShape, bbox, null).outline.length, 6)
  const adjacent = [
    { bbox: { x: 0, y: 0, width: 20, height: 30 }, status: 'recognized' as const },
    { bbox: { x: 20, y: 0, width: 20, height: 30 }, status: 'recognized' as const },
  ]
  assert.deepEqual(inferMatrixGrid(adjacent), { rows: 1, columns: 2 })
  assert.equal(blockGeometry(adjacent, { x: 0, y: 0, width: 40, height: 30 }, inferMatrixGrid(adjacent)).dividers[0].x1, 19.5)
  const nonuniform = [adjacent[0], { ...adjacent[1], bbox: { x: 19, y: 0, width: 23, height: 30 } }]
  assert.equal(inferMatrixGrid(nonuniform), null)
  assert.equal(blockGeometry(nonuniform, { x: 0, y: 0, width: 42, height: 30 }, null).dividers[0].x1, 19)
  const reviewed = cells.map((b, i) => ({ ...b, status: i === 0 ? 'needs_review' as const : b.status }))
  assert.ok(blockGeometry(reviewed, bbox, inferMatrixGrid(reviewed)).dividers.some(e => e.status === 'needs_review'))
  const hole = Array.from({ length: 9 }, (_, i) => ({
    bbox: { x: i % 3 * 19, y: Math.floor(i / 3) * 29, width: 20, height: 30 }, status: 'recognized' as const,
  })).filter((_, i) => i !== 4)
  assert.equal(inferMatrixGrid(hole), null)
  assert.equal(blockGeometry(hole, { x: 0, y: 0, width: 58, height: 88 }, null).outline.length, 8)
  const stairs = adjacent.map((b, i) => ({ ...b, bbox: { ...b.bbox, x: i * 19, y: i * 14 } }))
  assert.equal(inferMatrixGrid(stairs), null)
  assert.equal(blockGeometry(stairs, { x: 0, y: 0, width: 39, height: 44 }, null).dividers.length, 1)
})

test('schema 5 supports standalone Blocks and assigned Blocks without changing Booth coordinates', () => {
  const raw = fixture()
  const page = parsePreviewData(raw)[0]
  assert.equal(page.blocks?.length, 1)
  assert.equal(page.blocks?.[0].islandId, null)
  assert.equal(page.islandAssignment, null)
  assert.deepEqual(page.booths[0].bbox, raw.pages[0].booths[0].bbox)
  const assigned = parsePreviewData(assignedFixture())[0]
  assert.equal(assigned.blocks?.[0].islandId, 's1')
  assert.ok(assigned.booths.every(b => b.blockId === 'g1' && b.islandId === 's1'))
  for (const booth of raw.pages[0].booths) {
    booth.status = 'not_run'
  }
  assert.equal(parsePreviewData(raw)[0].blocks?.length, 1)
})

test('Block rendering strokes the complete outer frame before each unique inner divider', () => {
  const page = parsePreviewData(fixture())[0]
  assert.ok(page.blocks)
  const strokes: number[][][] = []
  let path: number[][] = []
  const context = {
    lineWidth: 0, strokeStyle: '',
    setLineDash(_segments: number[]) {},
    beginPath() { path = [] },
    moveTo(x: number, y: number) { path.push([x, y]) },
    lineTo(x: number, y: number) { path.push([x, y]) },
    stroke() { strokes.push(path) },
  }
  drawBlockBorders(context, page.blocks)
  assert.equal(strokes.length, 2)
  assert.equal(strokes[0].length, 8)
  assert.equal(strokes[1].length, 4)
  assert.deepEqual(strokes[1], [[29, 10], [29, 68], [10, 39], [48, 39]])
  assert.equal(context.lineWidth, 2)
})

function frameOptions(): PreviewOptions {
  return {
    background: false, boxes: false, blockFrames: true, numbers: false,
    islands: false, groups: false, gaps: false, selectedIsland: null,
  }
}

test('expanded Block frame stays exactly six source pixels outside each bounding edge without mutation', () => {
  const page = parsePreviewData(fixture())[0]
  assert.ok(page.blocks)
  const block = page.blocks[0]
  const before = JSON.stringify(page)
  const frame = expandedBlockFrame(block)
  assert.deepEqual(frame, { x: 4, y: 4, width: 50, height: 70 })
  assert.equal(block.bbox.x - frame.x, 6)
  assert.equal(block.bbox.y - frame.y, 6)
  assert.equal(frame.x + frame.width - (block.bbox.x + block.bbox.width - 1), 6)
  assert.equal(frame.y + frame.height - (block.bbox.y + block.bbox.height - 1), 6)
  assert.equal(JSON.stringify(page), before)
})

test('Block frame layer is independent of grid borders and respects its toggle and Island selection', () => {
  const page = parsePreviewData(assignedFixture())[0]
  const options = frameOptions()
  const rectangles: number[][] = []
  let dash: number[] = []
  const context = {
    lineWidth: 0, strokeStyle: '',
    setLineDash(segments: number[]) { dash = segments },
    strokeRect(x: number, y: number, width: number, height: number) { rectangles.push([x, y, width, height]) },
  }
  const layer = new BlockFrameLayer()
  layer.draw(context, { page, options })
  assert.deepEqual(rectangles, [[4, 4, 50, 70]])
  assert.deepEqual(dash, [6, 4])
  assert.equal(context.strokeStyle, '#1565c0')
  assert.equal(context.lineWidth, 2)
  rectangles.length = 0
  layer.draw(context, { page, options: { ...options, selectedIsland: 'other' } })
  layer.draw(context, { page, options: { ...options, blockFrames: false } })
  layer.draw(context, { page: { ...page, blocks: null }, options })
  assert.equal(rectangles.length, 0)
  layer.draw(context, { page, options: { ...options, selectedIsland: 's1' } })
  assert.equal(rectangles.length, 1)
})

test('preview margin contains expanded frames even when a Block touches all image edges', () => {
  const page = parsePreviewData(fixture())[0]
  assert.ok(page.blocks)
  const block = { ...page.blocks[0], bbox: { x: 0, y: 0, width: page.width, height: page.height } }
  const frame = expandedBlockFrame(block)
  const options = frameOptions()
  const margin = blockFrameMargin(page, options)
  assert.equal(margin, 8)
  assert.ok(frame.x + margin - 1 >= 0)
  assert.ok(frame.y + margin - 1 >= 0)
  assert.ok(frame.x + frame.width + margin + 1 <= page.width + margin * 2)
  assert.ok(frame.y + frame.height + margin + 1 <= page.height + margin * 2)
  assert.equal(blockFrameMargin(page, { ...options, blockFrames: false }), 0)
  assert.equal(blockFrameMargin({ ...page, blocks: null }, options), 0)
  assert.equal(blockFrameMargin({ ...page, blocks: [] }, options), 0)
})

test('schema 5 rejects missing members, stale bounds, duplicate edges and invalid Block references', () => {
  for (const mutate of [
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.blocks[0].boothIds.pop() },
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.blocks[0].boothIds.push('b0') },
    (d: ReturnType<typeof fixture>) => { d.pages[0].booths[0].blockId = 'missing' },
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.counts.blocks = 2 },
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.maxBorderPixelDistance = 2 },
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.blocks[0].bbox.width++ },
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.blocks[0].outline[0].x1 = -1 },
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.blocks[0].outline[0].y2 = 11 },
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.blocks[0].outline[0].x2 = NaN },
    (d: ReturnType<typeof fixture>) => { d.pages[0].blockGrouping.blocks[0].outline.push(d.pages[0].blockGrouping.blocks[0].dividers[0]) },
  ]) {
    const data = fixture()
    mutate(data)
    assert.throws(() => parsePreviewData(data))
  }
  const assigned = assignedFixture()
  assigned.pages[0].blockGrouping.blocks[0].islandId = 'other'
  assert.throws(() => parsePreviewData(assigned), /Island/)
})
