import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildOsmMap, mergeTags, stitchRings, tagValues } from '../../client/src/map/osm.ts'
import type { OsmFeature, OsmNode, OsmWay, Tags } from '../../client/src/map/osm.ts'
import { compareMapStyles, mapBackground, mapStyle, onewayTriangles } from '../../client/src/map/style.ts'
import {
  fitViewport, panViewport, projectCoordinate, screenToWorld, worldToScreen, zoomViewport,
} from '../../client/src/map/viewport.ts'

function nodes(): OsmNode[] {
  return [
    { id: '1', lat: 35.63, lon: 139.79, tags: {} },
    { id: '2', lat: 35.63, lon: 139.791, tags: {} },
    { id: '3', lat: 35.631, lon: 139.791, tags: {} },
    { id: '4', lat: 35.631, lon: 139.79, tags: {} },
    { id: '5', lat: 35.6302, lon: 139.7902, tags: { name: 'Station' } },
    { id: '6', lat: 35.6302, lon: 139.7908, tags: {} },
    { id: '7', lat: 35.6308, lon: 139.7908, tags: {} },
    { id: '8', lat: 35.6308, lon: 139.7902, tags: {} },
  ]
}

test('Mercator projection preserves east/right and north/up and validates coordinates', () => {
  const origin = projectCoordinate(35.63, 139.79)
  assert.ok(projectCoordinate(35.63, 139.80).x > origin.x)
  assert.ok(projectCoordinate(35.64, 139.79).y < origin.y)
  assert.ok(Number.isFinite(projectCoordinate(90, 180).y))
  for (const [lat, lon] of [[91, 0], [0, 181], [NaN, 0], [0, Infinity]]) {
    assert.throws(() => projectCoordinate(lat, lon), /经纬度/)
  }
})

test('fit contains the entire map and supports degenerate single-axis extents', () => {
  const bounds = { minX: -10, minY: 20, maxX: 90, maxY: 220 }
  const size = { width: 800, height: 600 }
  const view = fitViewport(bounds, size)
  const first = worldToScreen({ x: bounds.minX, y: bounds.minY }, view, size)
  const last = worldToScreen({ x: bounds.maxX, y: bounds.maxY }, view, size)
  assert.ok(first.x >= 32 && first.y >= 32)
  assert.ok(last.x <= size.width - 32 && last.y <= size.height - 32)
  assert.ok(Number.isFinite(fitViewport({ minX: 1, maxX: 1, minY: 1, maxY: 1 }, size).scale))
})

test('drag translates map by CSS pixels without changing scale', () => {
  const view = { center: { x: 100, y: 200 }, scale: 2 }
  const size = { width: 800, height: 600 }
  const point = { x: 110, y: 210 }
  const before = worldToScreen(point, view, size)
  const after = worldToScreen(point, panViewport(view, 60, -30), size)
  assert.deepEqual(after, { x: before.x + 60, y: before.y - 30 })
  assert.equal(panViewport(view, 60, -30).scale, 2)
})

test('zoom keeps the cursor world point fixed including at both scale limits', () => {
  const view = { center: { x: 100, y: 200 }, scale: 2 }
  const size = { width: 800, height: 600 }
  const anchor = { x: 137, y: 421 }
  const original = screenToWorld(anchor, view, size)
  for (const [factor, scale] of [[1.4, 2.8], [1e10, 100], [1e-10, 0.1]]) {
    const zoomed = zoomViewport(view, factor, anchor, size, 0.1, 100)
    assert.equal(zoomed.scale, scale)
    const result = screenToWorld(anchor, zoomed, size)
    assert.ok(Math.abs(result.x - original.x) < 1e-9)
    assert.ok(Math.abs(result.y - original.y) < 1e-9)
  }
})

test('OSM closed buildings are areas but closed roads and area=no are not', () => {
  const ways: OsmWay[] = [
    { id: 'building', refs: ['1', '2', '3', '4', '1'], tags: { building: 'yes' } },
    { id: 'road', refs: ['1', '2', '3', '4', '1'], tags: { highway: 'residential' } },
    { id: 'outline', refs: ['1', '2', '3', '4', '1'], tags: { building: 'yes', area: 'no' } },
  ]
  const result = buildOsmMap(nodes(), ways, [])
  assert.deepEqual(result.features.map(feature => feature.area), [true, false, false])
  assert.equal(result.places[0].name, 'Station')
  assert.equal(result.warnings.length, 0)
  assert.ok(result.bounds.minX < result.bounds.maxX)
})

test('multipolygons join reversed fragments and preserve inner holes', () => {
  assert.deepEqual(stitchRings([['1', '2'], ['4', '1'], ['4', '3'], ['2', '3']]), [['1', '2', '3', '4', '1']])
  assert.equal(stitchRings([['1', '2'], ['3', '4']]), null)
  const ways: OsmWay[] = [
    { id: 'outer1', refs: ['1', '2', '3'], tags: { building: 'yes' } },
    { id: 'outer2', refs: ['1', '4', '3'], tags: {} },
    { id: 'inner', refs: ['5', '6', '7', '8', '5'], tags: {} },
  ]
  const result = buildOsmMap(nodes(), ways, [{
    id: 'relation', tags: { type: 'multipolygon', building: 'yes', name: 'Hall' },
    members: [
      { type: 'way', ref: 'outer1', role: 'outer' }, { type: 'way', ref: 'outer2', role: 'outer' },
      { type: 'way', ref: 'inner', role: 'inner' },
    ],
  }])
  const polygon = result.features.find(feature => feature.id === 'relation/relation')
  assert.equal(polygon?.paths.length, 2)
  assert.equal(polygon?.area, true)
  assert.equal(result.warnings.length, 0)
})

test('missing nodes break lines instead of creating false bridges or polygon fills', () => {
  const result = buildOsmMap(nodes(), [{
    id: 'partial', refs: ['1', '2', 'missing', '3', '4', '1'], tags: { building: 'yes' },
  }], [{
    id: 'incomplete', tags: { type: 'multipolygon' },
    members: [{ type: 'way', ref: 'absent', role: 'outer' }],
  }])
  assert.equal(result.features.length, 1)
  assert.equal(result.features[0].paths.length, 2)
  assert.equal(result.features[0].area, false)
  assert.equal(result.warnings.length, 2)
  assert.throws(() => buildOsmMap([], [], []), /没有可绘制/)
})

test('duplicate OSM objects fail explicitly', () => {
  assert.throws(() => buildOsmMap([...nodes(), nodes()[0]], [], []), /重复/)
  const way = { id: 'w', refs: ['1', '2'], tags: {} }
  assert.throws(() => buildOsmMap(nodes(), [way, way], []), /重复/)
})

function feature(tags: Tags, area = false): OsmFeature {
  return {
    id: 'test', tags, area, paths: [[{ x: 0, y: 0 }, { x: 100, y: 0 }]],
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 0 },
  }
}

test('reference palette uses hall colors and hall-code labels instead of ordinary names', () => {
  assert.equal(mapBackground, '#f6f4ef')
  for (const [hall, field, prefix, fill, color] of [
    ['e', 'hall:e', '東', 'rgba(238, 137, 137, 0.57)', '#b43a3a'],
    ['w', 'hall:w', '西', 'rgba(136, 183, 248, 0.38)', '#2a57ad'],
    ['s', 'hall:s', '南', 'rgba(127, 228, 162, 0.32)', '#2f8a4d'],
  ]) {
    const style = mapStyle(feature({ building: 'yes', hall, [field]: '1', 'tokyo-big-sight': 'yes' }, true))
    assert.equal(style.fill, fill)
    assert.deepEqual(style.hallLabel, { text: `${prefix}1`, color })
    assert.equal(style.strokeWidth, 1.05)
    assert.equal(style.layer, 20)
  }
  assert.equal(mapStyle(feature({ building: 'yes', name: 'Ordinary building' })).hallLabel, null)
})

test('reference scope fades outside features but preserves tagged indoor and hall colors', () => {
  const outside = mapStyle(feature({ building: 'yes', hall: 'e' }, true))
  assert.equal(outside.fill, 'rgba(135, 139, 143, 0.18)')
  assert.equal(outside.stroke, 'rgba(116, 121, 125, 0.46)')
  const indoor = mapStyle(feature({ indoor: 'corridor', hall: 'w', 'tokyo-big-sight': 'yes' }))
  assert.equal(indoor.stroke, 'rgba(88, 126, 188, 0.54)')
  assert.equal(indoor.fill, null)
  const perimeter = mapStyle(feature({ 'tokyo-big-sight': 'yes' }, true))
  assert.equal(perimeter.fill, 'rgba(224, 104, 170, 0.24)')
  assert.equal(perimeter.layer, -5)
})

test('reference footways are solid green and only steps have meter-based dashes', () => {
  const tags = { highway: 'footway', 'path:e-entry': 'yes', 'tokyo-big-sight': 'path' }
  const footway = mapStyle(feature(tags))
  assert.equal(footway.stroke, '#00b86b')
  assert.equal(footway.strokeWidth, 0.9)
  assert.deepEqual(footway.lineDash, [])
  const stairs = mapStyle(feature({ ...tags, highway: 'steps' }))
  assert.equal(stairs.strokeWidth, 1.05)
  assert.deepEqual(stairs.lineDash, [1.2, 2.4])
  const road = mapStyle(feature({ highway: 'tertiary', 'tokyo-big-sight': 'yes' }))
  assert.equal(road.stroke, '#b4b8bd')
  assert.equal(road.strokeWidth, 10)
  assert.equal(road.layer, 100)
})

test('reference pedestrian areas, bridges, railways and platforms retain their distinct styles', () => {
  const base = { 'tokyo-big-sight': 'yes' }
  const pedestrian = mapStyle(feature({ ...base, highway: 'pedestrian' }, true))
  assert.equal(pedestrian.fill, 'rgba(122, 225, 218, 0.34)')
  assert.equal(pedestrian.stroke, null)
  const bridge = mapStyle(feature({ ...base, highway: 'pedestrian', bridge: 'yes' }, true))
  assert.equal(bridge.strokeWidth, 1.25)
  assert.equal(bridge.layer, 101)
  const rail = mapStyle(feature({ ...base, railway: 'rail' }))
  assert.equal(rail.stroke, 'rgba(42, 93, 158, 0.68)')
  assert.equal(rail.strokeWidth, 2.4)
  assert.deepEqual(rail.lineDash, [])
  const platform = mapStyle(feature({ ...base, railway: 'platform' }, true))
  assert.equal(platform.stroke, null)
  assert.equal(platform.fill, 'rgba(120, 128, 136, 0.28)')
})

test('reference drawing order uses level then type layer, with level zero mapped to one', () => {
  const low = mapStyle(feature({ level: '-1', highway: 'tertiary' }))
  const hall = mapStyle(feature({ level: '1', building: 'yes', 'hall:e': '1' }))
  const road = mapStyle(feature({ level: '0', highway: 'footway' }))
  const high = mapStyle(feature({ level: '2', building: 'yes' }))
  assert.equal(road.level, 1)
  assert.deepEqual([high, road, hall, low].sort(compareMapStyles), [low, hall, road, high])
})

test('active relation tags accumulate without losing conflicting values or mutating input', () => {
  const way: OsmWay = { id: 'path', refs: ['1', '2'], tags: { highway: 'footway' } }
  const result = buildOsmMap(nodes(), [way], [
    { id: 'entry', tags: { 'path:e-entry': 'yes', 'tokyo-big-sight': 'path' },
      members: [{ type: 'way', ref: 'path', role: '' }] },
    { id: 'exit', tags: { 'path:s-to-e': 'yes', oneway: 'yes' },
      members: [{ type: 'way', ref: 'path', role: '' }] },
  ])
  assert.equal(mapStyle(result.features[0]).stroke, '#00b86b')
  assert.equal(result.features[0].tags.oneway, 'yes')
  assert.equal(result.features[0].tags['path:s-to-e'], 'yes')
  assert.deepEqual(way.tags, { highway: 'footway' })
  const tags = mergeTags({ hall: 'e' }, { hall: 'w' }, { hall: 'e' })
  assert.deepEqual(tagValues(tags, 'hall'), ['e', 'w'])
})

test('compound polygons inherit outer hall tags and do not duplicate hall labels or boundary strokes', () => {
  const result = buildOsmMap(nodes(), [{
    id: 'ring', refs: ['1', '2', '3', '4', '1'],
    tags: { building: 'yes', hall: 'e', 'hall:e': '2', 'tokyo-big-sight': 'yes' },
  }], [{
    id: 'hall', tags: { type: 'multipolygon' },
    members: [{ type: 'way', ref: 'ring', role: 'outer' }],
  }])
  const compound = mapStyle(result.features.find(item => item.id === 'relation/hall')!)
  const member = mapStyle(result.features.find(item => item.id === 'way/ring')!)
  assert.deepEqual(compound.hallLabel, { text: '東2', color: '#b43a3a' })
  assert.equal(member.hallLabel, null)
  assert.equal(member.fill, null)
  assert.equal(member.stroke, null)
})

test('one-way arrows use ground-meter spacing, reverse direction and never cross gaps', () => {
  const paths = [[{ x: 0, y: 0 }, { x: 100, y: 0 }]]
  const forward = onewayTriangles(paths, { oneway: 'yes' }, 1)
  const reverse = onewayTriangles(paths, { oneway: '-1' }, 1)
  assert.deepEqual(forward.map(triangle => triangle[0].x), [15, 45, 75])
  assert.ok(forward[0][0].x > forward[0][1].x)
  assert.ok(reverse[0][0].x < reverse[0][1].x)
  const mercator = onewayTriangles([[{ x: 0, y: 0 }, { x: 200, y: 0 }]], { oneway: 'yes' }, 0.5)
  assert.deepEqual(mercator.map(triangle => triangle[0].x), [30, 90, 150])
  assert.deepEqual(onewayTriangles(paths, { oneway: 'no' }, 1), [])
  const gaps = onewayTriangles([
    [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 90, y: 0 }, { x: 100, y: 0 }],
  ], { oneway: 'yes' }, 1)
  assert.deepEqual(gaps, [])
  const rail = onewayTriangles(paths, { oneway: 'yes', railway: 'rail' }, 1)
  assert.ok(Math.abs((rail[0][0].x - rail[0][1].x) - 3.4) < 1e-9)
})
