import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHalls, hallMatrix, pointsBounds } from '../../client/src/map/halls.ts'
import type { HallPlacement, MapHall } from '../../client/src/map/halls.ts'
import { recalculateHallTransforms } from '../../client/src/map/hallPreparation.ts'
import { hallContained, hallEnvelope, hallUnionBoundary } from '../../client/src/map/hallRegistration.ts'
import type { OsmFeature, OsmMapData, Tags } from '../../client/src/map/osm.ts'
import type { Point } from '../../client/src/map/viewport.ts'

function rectangle(x: number, y: number, width: number, height: number): Point[] {
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
}

function fixture(boundary = rectangle(0, 0, 200, 100)): MapHall {
  return parseHalls({ halls: [{
    name: 'Composite', textRotation: 0, boundary,
    labels: [
      { id: 'l1', code: 'E1', text: '東1', pos: { x: 50, y: 5 } },
      { id: 'l2', code: 'E1', text: 'E1', pos: { x: 50, y: 95 } },
      { id: 'l3', code: 'E2', text: '東2', pos: { x: 150, y: 5 } },
      { id: 'l4', code: 'E2', text: 'E2', pos: { x: 150, y: 95 } },
    ],
    islands: [{ id: 'i1', code: 'A', markers: [], blocks: [{
      id: 'block1', bbox: { x: 10, y: 10, width: 40, height: 20 },
      booths: [{ id: 'booth1', number: '01', bbox: { x: 10, y: 10, width: 40, height: 20 }, split: null }],
    }] }],
  }] })[0]
}

function placement(): HallPlacement {
  return {
    hallIndex: 0, name: 'Composite', anchor: { latitude: 35.63, longitude: 139.79 },
    offset: { x: 130, y: -80 }, rotation: 83, scale: 0.5, aspectRatio: 3,
  }
}

function transform(hall: MapHall, p: HallPlacement, point: Point): Point {
  const [a, b, c, d, e, f] = hallMatrix(hall, p)
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f }
}

function feature(hall: MapHall, p: HallPlacement, id: string, ring: Point[], tags: Tags): OsmFeature {
  const points = ring.map(point => transform(hall, p, point))
  return { id, tags, area: true, paths: [[...points, points[0]]], bounds: pointsBounds(points) }
}

function map(features: OsmFeature[]): OsmMapData {
  return { features, places: [], warnings: [], bounds: pointsBounds(features.flatMap(f => f.paths.flat())) }
}

function assertFit(hall: MapHall, actual: HallPlacement, expected: HallPlacement) {
  assert.ok(Math.abs(actual.scale - expected.scale) < 0.0001, `scale: ${actual.scale} vs ${expected.scale}`)
  assert.ok(Math.abs(actual.rotation - expected.rotation) < 0.05, `rotation: ${actual.rotation} vs ${expected.rotation}`)
  assert.deepEqual(actual.anchor, expected.anchor)
  assert.equal(actual.aspectRatio, 0.5)
  for (const point of hall.page.hallOutline!.polygon) {
    const p = transform(hall, actual, point), q = transform(hall, expected, point)
    assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 0.02, `point error: ${Math.hypot(p.x - q.x, p.y - q.y)}`)
  }
}

test('union retains concave exterior, removes seams, overlap and duplicate/reversed footprints', () => {
  for (const [rings, perimeter, area] of [
    [[rectangle(0, 0, 10, 10), rectangle(5, 0, 10, 10)], 50, 150],
    [[rectangle(0, 0, 10, 10), rectangle(0, 0, 10, 10).reverse()], 40, 100],
    [[rectangle(0, 0, 15, 5), rectangle(0, 5, 5, 10)], 60, 125],
  ] as [Point[][], number, number][]) {
    const segments = hallUnionBoundary(rings)
    const length = segments.reduce((sum, s) => sum + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y), 0)
    const signedArea = segments.reduce((sum, s) => sum + s.start.x * s.end.y - s.end.x * s.start.y, 0) / 2
    assert.ok(Math.abs(length - perimeter) < 1e-8)
    assert.ok(Math.abs(signedArea - area) < 1e-8)
  }
})

test('coded marker groups resolve symmetry and exact fitting recovers position, scale and clockwise rotations', () => {
  for (const rotation of [0, 37, -173, 146]) {
    const hall = fixture(), initial = placement()
    hall.labels.forEach(label => {
      label.center.x += 30
      label.center.y -= 20
    })
    const expected = { ...initial, offset: { x: 12, y: -24 }, scale: 0.12, aspectRatio: 0.5, rotation }
    const first = feature(hall, expected, 'e1', rectangle(0, 0, 100, 100), { 'hall-e': '1' })
    const second = feature(hall, expected, 'e2', rectangle(100, 0, 100, 100), { 'hall:e': '2' })
    const unrelated = feature(hall, initial, 'e3', rectangle(0, 0, 2000, 1000), { 'hall-e': '3' })
    const duplicateMember = { ...unrelated, id: 'member', polygonMember: true, tags: { 'hall-e': '1' } }
    const data = map([second, first, unrelated, duplicateMember])
    const config = { schemaVersion: 1 as const, placements: [initial] }
    const before = structuredClone({ hall, config, data })
    const result = recalculateHallTransforms([hall], config, data)
    assertFit(hall, result.transforms.placements[0], expected)
    assert.ok(result.reports[0].rmsErrorMeters < 0.01)
    assert.equal(result.reports[0].orientation, 'markers')
    assert.equal(result.reports[0].contained, true)
    assert.deepEqual(result.reports[0].codes, ['E1', 'E2'])
    assert.deepEqual({ hall, config, data }, before)
    assert.deepEqual(recalculateHallTransforms([hall], result.transforms, data), result)
  }
})

test('single asymmetric nonconvex hall uses boundary search rather than its initial rotation', () => {
  const boundary = [
    { x: 0, y: 0 }, { x: 180, y: 0 }, { x: 180, y: 50 },
    { x: 70, y: 50 }, { x: 70, y: 160 }, { x: 0, y: 160 },
  ]
  const hall = fixture(boundary), initial = placement()
  hall.labels = [hall.labels[0]]
  hall.labels[0].code = 'E7'
  const expected = { ...initial, offset: { x: -23, y: 45 }, rotation: 61, scale: 0.15, aspectRatio: 0.5 }
  const data = map([feature(hall, expected, 'e7', boundary, { 'hall-e': '7' })])
  const result = recalculateHallTransforms([hall], { schemaVersion: 1, placements: [initial] }, data)
  assertFit(hall, result.transforms.placements[0], expected)
  assert.equal(result.reports[0].orientation, 'boundary')
  assert.ok(result.reports[0].relativeError < 0.0001)
})

test('batch registration distinguishes same-name pages by index and does not partially apply a failed Hall', () => {
  const first = fixture(), second = fixture()
  second.index = 1
  second.labels.forEach(label => { label.code = label.code === 'E1' ? 'W1' : 'W2' })
  const initial = placement(), other = { ...placement(), hallIndex: 1 }
  const expected = { ...initial, offset: { x: 25, y: 40 }, scale: 0.1, rotation: 32, aspectRatio: 0.5 }
  const otherExpected = { ...other, offset: { x: 300, y: 200 }, scale: 0.08, rotation: -55, aspectRatio: 0.5 }
  const data = map([
    feature(first, expected, 'e1', rectangle(0, 0, 100, 100), { 'hall-e': '1' }),
    feature(first, expected, 'e2', rectangle(100, 0, 100, 100), { 'hall-e': '2' }),
    feature(second, otherExpected, 'w1', rectangle(0, 0, 100, 100), { 'hall-w': '1' }),
    feature(second, otherExpected, 'w2', rectangle(100, 0, 100, 100), { 'hall-w': '2' }),
  ])
  const config = { schemaVersion: 1 as const, placements: [other, initial] }
  const before = structuredClone(config)
  const result = recalculateHallTransforms([first, second], config, data)
  assertFit(second, result.transforms.placements[0], otherExpected)
  assertFit(first, result.transforms.placements[1], expected)
  assert.deepEqual(result.reports.map(report => report.hallIndex), [1, 0])
  data.features.pop()
  assert.throws(() => recalculateHallTransforms([first, second], config, data), /Composite.*W2/)
  assert.deepEqual(config, before)
})

test('missing, invalid, coincident or symmetric registration evidence fails explicitly without replacing the batch', () => {
  const hall = fixture(), initial = placement()
  const target = { ...initial, scale: 0.12, aspectRatio: 0.5 }
  const data = map([
    feature(hall, target, 'e1', rectangle(0, 0, 100, 100), { 'hall-e': '1' }),
    feature(hall, target, 'e2', rectangle(100, 0, 100, 100), { 'hall-e': '2' }),
  ])
  const config = { schemaVersion: 1 as const, placements: [initial] }, before = structuredClone(config)
  const noLabels = structuredClone(hall)
  noLabels.labels = []
  assert.throws(() => recalculateHallTransforms([noLabels], config, data), /Composite.*没有有效的子馆标签/)
  const missing = structuredClone(data)
  missing.features.pop()
  assert.throws(() => recalculateHallTransforms([hall], config, missing), /Composite.*E2/)
  const open = structuredClone(data)
  open.features[0].paths[0].pop()
  assert.throws(() => recalculateHallTransforms([hall], config, open), /未闭合/)
  const coincident = structuredClone(hall)
  coincident.labels.forEach(label => { label.center = { x: 50, y: 50 } })
  assert.throws(() => recalculateHallTransforms([coincident], config, data), /不能确定方向/)
  const single = structuredClone(hall)
  single.labels = [single.labels[0]]
  const symmetric = map([feature(single, target, 'e1', rectangle(0, 0, 200, 100), { 'hall-e': '1' })])
  assert.throws(() => recalculateHallTransforms([single], config, symmetric), /对称方向歧义/)
  assert.deepEqual(config, before)
})

test('containment checks full edges, narrow notches, holes and real gaps rather than only vertices', () => {
  const source = rectangle(10, 10, 80, 80)
  const notch = [
    { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 50.001, y: 50 },
    { x: 50.001, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ]
  assert.equal(hallContained(source, [[notch]]), false)
  assert.equal(hallContained(source, [[rectangle(0, 0, 100, 100), rectangle(45, 45, 0.001, 0.001)]]), false)
  assert.equal(hallContained(source, [[rectangle(0, 0, 50, 100)], [rectangle(50.01, 0, 49.99, 100)]]), false)
  assert.equal(hallContained(source, [[rectangle(0, 0, 50, 100)], [rectangle(50, 0, 50, 100)]]), true)
  assert.equal(hallContained(rectangle(0, 0, 50, 100), [[rectangle(0, 0, 50, 100)]]), true)
})

test('concave envelope joins disconnected subhalls and fills enclosed holes without unnecessary shrinking', () => {
  for (const hole of [false, true]) {
    const hall = fixture(), initial = placement()
    const expected = { ...initial, offset: { x: 25, y: 40 }, scale: 0.1, rotation: 32, aspectRatio: 0.5 }
    const first = feature(hall, expected, 'e1', rectangle(0, 0, 100, 100), { 'hall-e': '1' })
    const second = feature(hall, expected, 'e2', rectangle(101, 0, 99, 100), { 'hall-e': '2' })
    if (hole) {
      const points = rectangle(120, 30, 40, 40).map(point => transform(hall, expected, point))
      second.paths.push([...points, points[0]])
    }
    const data = map([first, second])
    const result = recalculateHallTransforms([hall], { schemaVersion: 1, placements: [initial] }, data)
    const fitted = result.transforms.placements[0]
    const body = hall.page.hallOutline!.polygon.map(point => transform(hall, fitted, point))
    assert.equal(hallContained(body, [[result.reports[0].envelope]]), true)
    assert.equal(hallContained(body, data.features.map(f => f.paths.map(p => p.slice(0, -1)))), false)
    assert.ok(fitted.scale > expected.scale * 0.95)
    assert.equal(result.reports[0].contained, true)
  }
})

test('axis-edge priority preserves major horizontal/vertical directions despite a mismatched oblique edge', () => {
  const boundary = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 50 }, { x: 200, y: 100 }, { x: 0, y: 100 }]
  const hall = fixture(boundary), initial = placement()
  hall.labels = [hall.labels[0]]
  hall.labels[0].code = 'E7'
  const expected = { ...initial, offset: { x: -23, y: 45 }, rotation: 56, scale: 0.15, aspectRatio: 0.5 }
  const outline = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 200, y: 25 }, { x: 200, y: 100 }, { x: 0, y: 100 }]
  const data = map([feature(hall, expected, 'e7', outline, { 'hall-e': '7' })])
  const result = recalculateHallTransforms([hall], { schemaVersion: 1, placements: [initial] }, data)
  const fitted = result.transforms.placements[0]
  assert.ok(Math.abs(fitted.rotation - expected.rotation) < 1e-8, `rotation drift: ${fitted.rotation}`)
  assert.ok(result.reports[0].alignment)
  assert.ok(result.reports[0].alignment.angleErrorDegrees < 1e-6)
  assert.equal(hallContained(boundary.map(point => transform(hall, fitted, point)), data.features.map(f => f.paths.map(p => p.slice(0, -1)))), true)
  assert.ok(result.reports[0].axisRmsErrorMeters !== null)
})

test('concave lasso retains broad exterior recesses, fills inner courtyard and covers all subhall edges', () => {
  const u = [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 15 }, { x: 70, y: 15 },
    { x: 70, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ]
  const hole = rectangle(10, 70, 10, 10)
  const envelope = hallEnvelope([[u, hole], [rectangle(100.01, 80, 20, 20)]])
  assert.equal(hallContained(u, [[envelope]]), true)
  assert.equal(hallContained(hole, [[envelope]]), true)
  assert.equal(hallContained(rectangle(100.01, 80, 20, 20), [[envelope]]), true)
  assert.equal(hallContained(rectangle(45, 2, 10, 5), [[envelope]]), false)
  assert.deepEqual(hallEnvelope([[u]]).length, u.length)
  assert.ok(envelope.length > 4)
  const translated = 15000000
  const ring = hallEnvelope([[u.map(p => ({ x: p.x + translated, y: p.y - translated }))]])
  assert.equal(hallContained(u.map(p => ({ x: p.x + translated, y: p.y - translated })), [[ring]]), true)
})

test('multi-subhall lasso bridges a deep open courtyard while retaining single-hall concavity', () => {
  const left = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 70 }, { x: 60, y: 70 }, { x: 60, y: 100 }, { x: 0, y: 100 }]
  const right = rectangle(60, 0, 40, 100)
  const envelope = hallEnvelope([[left], [right]])
  assert.equal(hallContained(rectangle(35, 10, 20, 50), [[envelope]]), true)
  assert.equal(hallContained(left, [[envelope]]), true)
  assert.equal(hallContained(right, [[envelope]]), true)
  assert.equal(hallContained(rectangle(35, 10, 20, 50), [[hallEnvelope([[left]])]]), false)
})

test('an impossible minimum-scale containment fails explicitly without modifying the previous placements', () => {
  const hall = fixture(), initial = placement()
  const tooSmall = { ...initial, offset: { x: 0, y: 0 }, scale: 0.00002, rotation: 32, aspectRatio: 0.5 }
  const data = map([
    feature(hall, tooSmall, 'e1', rectangle(0, 0, 100, 100), { 'hall-e': '1' }),
    feature(hall, tooSmall, 'e2', rectangle(100, 0, 100, 100), { 'hall-e': '2' }),
  ])
  const config = { schemaVersion: 1 as const, placements: [initial] }, before = structuredClone(config)
  assert.throws(() => recalculateHallTransforms([hall], config, data), /Composite.*支持缩放范围.*完整包含/)
  assert.deepEqual(config, before)
})

test('Booths beyond a pixel-inclusive PDF frame are included in optimization without preventing axis alignment', () => {
  const hall = fixture(), initial = placement()
  hall.page.booths[0].bbox = { x: 190, y: 40, width: 11, height: 10 }
  const expected = { ...initial, scale: 0.12, aspectRatio: 10 / 11, rotation: 37 }
  const data = map([
    feature(hall, expected, 'e1', rectangle(0, 0, 100, 100), { 'hall-e': '1' }),
    feature(hall, expected, 'e2', rectangle(100, 0, 100, 100), { 'hall-e': '2' }),
  ])
  const result = recalculateHallTransforms([hall], { schemaVersion: 1, placements: [initial] }, data)
  const fitted = result.transforms.placements[0], envelope = result.reports[0].envelope
  const corners = rectangle(190, 40, 11, 10).map(point => transform(hall, fitted, point))
  assert.equal(hallContained(corners, [[envelope]]), true)
  assert.equal(hallContained(hall.page.hallOutline!.polygon.map(point => transform(hall, fitted, point)), [[envelope]]), true)
  assert.ok(result.reports[0].alignment)
  assert.ok(result.reports[0].alignment.angleErrorDegrees < 1e-6)
})
