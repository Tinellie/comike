import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildOsmMap, featureLevels, hallCodes, mergeTags, stitchRings, tagValues } from '../../client/src/map/osm.ts'
import type { OsmFeature, OsmNode, OsmWay, Tags } from '../../client/src/map/osm.ts'
import { outsideHallKey, projectHallPerimeter } from '../../client/src/map/hallPerimeter.ts'
import {
  compareMapStyles, filteredLevelStyle, filteredOutline, hallLabel, mapBackground, mapStyle, matchesLevels, onewayTriangles, opaqueOnWhite,
} from '../../client/src/map/style.ts'
import {
  dragRotation, fitViewport, panViewport, projectCoordinate, screenToWorld, viewportBounds, worldToScreen, zoomViewport,
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

test('outside hall paths use only the matching relation members and do not bridge missing nodes', () => {
  const ways: OsmWay[] = [
    { id: 'outside', refs: ['1', '2', 'missing', '3', '4'], tags: {} },
    { id: 'other', refs: ['2', '3'], tags: { 'outside-hall': 'e123' } },
  ]
  const data = buildOsmMap(nodes(), ways, [
    { id: '1', tags: { 'outside-hall': 'e123' }, members: [{ type: 'way', ref: 'outside', role: '' }] },
    { id: '2', tags: { name: 'hall-outside-w12' }, members: [{ type: 'way', ref: 'other', role: '' }] },
  ])
  assert.deepEqual(data.outsideHallRoutes.get(outsideHallKey(['E3', null, 'E1', 'E3', 'E2'])!)
    ?.map(({ from, to }) => [from, to]), [['1', '2'], ['3', '4']])
  assert.deepEqual(data.outsideHallRoutes.get('w12')?.map(({ from, to }) => [from, to]), [['2', '3']])
})

test('named queue and connector highlights use the correct hall and only their own drawable way members', () => {
  const wayMember = (ref: string) => ({ type: 'way', ref, role: '' })
  const data = buildOsmMap(nodes(), [
    { id: 'shared', refs: ['1', '2'], tags: {} },
    { id: 'connector', refs: ['2', '3'], tags: {} },
    { id: 'node-only', refs: ['3', '4'], tags: {} },
  ], [
    { id: '1', tags: { name: '西南待機列' }, members: [
      wayMember('shared'), wayMember('shared'), wayMember('missing'), { type: 'node', ref: 'node-only', role: '' },
    ] },
    { id: '2', tags: { name: '西-東連絡通路' }, members: [wayMember('shared'), wayMember('connector')] },
    { id: '3', tags: { name: 'outside-hall-e123' }, members: [wayMember('node-only')] },
  ])
  assert.deepEqual(data.namedRoutes, [
    { id: '1', name: '西南待機列', hall: '西', wayIds: ['way/shared'] },
    { id: '2', name: '西-東連絡通路', hall: '東', wayIds: ['way/shared', 'way/connector'] },
  ])
})

test('all perimeter nodes snap to the nearest road and projected edges follow bends', () => {
  const p = (x: number, y: number) => ({ x, y })
  const route = [
    { from: 'a', to: 'b', start: p(0, 0), end: p(10, 0) },
    { from: 'b', to: 'c', start: p(10, 0), end: p(10, 10) },
  ]
  const geometry = [p(2, -100), p(12, 8), p(12, 8), p(1, -101)]
  const edges = [
    { from: 0, to: 1, kind: 'perimeter' }, { from: 1, to: 2, kind: 'perimeter' },
    { from: 0, to: 3, kind: 'indoor' },
  ] as const
  assert.deepEqual(projectHallPerimeter(geometry, edges, route), {
    perimeter: [[p(10, 0), p(10, 8)], [p(2, 0), p(10, 0)]],
    links: [[p(2, -100), p(2, 0)]], disconnected: 0,
  })
  assert.deepEqual(projectHallPerimeter(geometry, edges, [route[0], { ...route[1], from: 'd' }]), {
    perimeter: [], links: [[p(2, -100), p(2, 0)]], disconnected: 1,
  })
})

test('PDF occupied subhall codes hide only matching OSM labels and retain uncovered codes', () => {
  const occupied = new Set(['E1', 'E2', 'W1'])
  assert.equal(hallLabel({ 'hall-e': '1' }, occupied), null)
  assert.equal(hallLabel({ 'hall:e': '2' }, occupied), null)
  assert.equal(hallLabel({ 'hall:w': '1' }, occupied), null)
  assert.equal(hallLabel({ 'hall-e': '1;2' }, occupied), null)
  assert.deepEqual(hallLabel({ 'hall:e': ['1', '3'] }, occupied), { text: '東3', color: '#b43a3a' })
  assert.deepEqual(hallLabel({ 'hall:e': '3' }, occupied), hallLabel({ 'hall:e': '3' }))
  assert.deepEqual(hallLabel({ 'hall:w': '2' }, occupied), hallLabel({ 'hall:w': '2' }))
  assert.deepEqual(hallLabel({ 'hall-e': '1' }, new Set()), hallLabel({ 'hall-e': '1' }))
})

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

test('rotated view preserves inverse coordinates, screen-space panning and cursor-anchored zoom', () => {
  const size = { width: 900, height: 600 }, point = { x: 135, y: 210 }
  for (const rotation of [-179, -90, -35, 0, 47, 90, 180]) {
    const view = { center: { x: 100, y: 200 }, scale: 2, rotation }
    const before = worldToScreen(point, view, size)
    const inverse = screenToWorld(before, view, size)
    assert.ok(Math.hypot(inverse.x - point.x, inverse.y - point.y) < 1e-10)
    const after = worldToScreen(point, panViewport(view, 60, -30), size)
    assert.ok(Math.hypot(after.x - before.x - 60, after.y - before.y + 30) < 1e-10)
    const anchor = { x: 123, y: 456 }, world = screenToWorld(anchor, view, size)
    for (const factor of [1.4, 1e10, 1e-10]) {
      const zoomed = zoomViewport(view, factor, anchor, size, 0.1, 100)
      const fixed = worldToScreen(world, zoomed, size)
      assert.equal(zoomed.rotation, rotation)
      assert.ok(Math.hypot(fixed.x - anchor.x, fixed.y - anchor.y) < 1e-9)
    }
    const bounds = viewportBounds(view, size)
    for (const x of [0, size.width]) for (const y of [0, size.height]) {
      const corner = screenToWorld({ x, y }, view, size)
      assert.ok(corner.x >= bounds.minX && corner.x <= bounds.maxX)
      assert.ok(corner.y >= bounds.minY && corner.y <= bounds.maxY)
    }
    assert.deepEqual(worldToScreen(view.center, view, size), { x: size.width / 2, y: size.height / 2 })
  }
})

test('rotated fit contains all corners and Alt drag follows the shortest angle around viewport center', () => {
  const bounds = { minX: -200, minY: -10, maxX: 300, maxY: 100 }, size = { width: 800, height: 600 }
  for (const rotation of [-135, -90, 37, 90, 145]) {
    const view = fitViewport(bounds, size, rotation)
    for (const x of [bounds.minX, bounds.maxX]) for (const y of [bounds.minY, bounds.maxY]) {
      const screen = worldToScreen({ x, y }, view, size)
      assert.ok(screen.x >= 32 - 1e-9 && screen.x <= size.width - 32 + 1e-9)
      assert.ok(screen.y >= 32 - 1e-9 && screen.y <= size.height - 32 + 1e-9)
    }
  }
  const center = { x: 400, y: 300 }
  assert.equal(dragRotation({ x: 500, y: 300 }, { x: 400, y: 400 }, center), 90)
  assert.equal(dragRotation({ x: 300, y: 301 }, { x: 300, y: 299 }, center) < 2, true)
  assert.equal(dragRotation(center, { x: 400, y: 400 }, center), 0)
})

test('level selection uses exact numeric tags, fades unmatched objects without changing stroke format', () => {
  assert.deepEqual(featureLevels({ level: ['1;2', '3,4', '2', '', 'invalid'] }), [1, 2, 3, 4])
  assert.deepEqual(featureLevels({ level: '0;-1;1.5' }), [0, -1, 1.5])
  assert.equal(matchesLevels([], new Set()), true)
  assert.equal(matchesLevels([], new Set([1])), false)
  assert.equal(matchesLevels([0], new Set([1])), false)
  assert.equal(matchesLevels([1, 3], new Set([2, 3])), true)
  assert.equal(matchesLevels([1], new Set([2, 3])), false)
  assert.equal(mapStyle(feature({ level: '0' })).level, 0)
  assert.equal(mapStyle(feature({ level: '3;1' })).level, 1)
  for (const tags of [
    { highway: 'steps', level: '3', 'tokyo-big-sight': 'yes' },
    { building: 'yes', 'hall-e': '1', level: '2', 'tokyo-big-sight': 'yes' },
  ]) {
    const original = mapStyle(feature(tags, true)), before = structuredClone(original)
    const faded = filteredLevelStyle(original)
    assert.equal(faded.stroke, filteredOutline)
    assert.equal(faded.fill, null)
    assert.equal(faded.hallLabel, null)
    assert.equal(faded.strokeWidth, original.strokeWidth)
    assert.deepEqual(faded.lineDash, original.lineDash)
    assert.equal(faded.level, original.level)
    assert.equal(faded.layer, original.layer)
    assert.deepEqual(original, before)
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
    ['e', 'hall:e', '東', 'rgba(238, 137, 137, 0.48)', '#b43a3a'],
    ['w', 'hall:w', '西', 'rgba(136, 183, 248, 0.4)', '#2a57ad'],
    ['s', 'hall:s', '南', 'rgba(127, 228, 162, 0.38)', '#2f8a4d'],
  ]) {
    const style = mapStyle(feature({ building: 'yes', hall, [field]: '1', 'tokyo-big-sight': 'yes' }, true))
    assert.equal(style.fill, fill)
    assert.deepEqual(style.hallLabel, { text: `${prefix}1`, color })
    assert.equal(style.strokeWidth, 1.05)
    assert.equal(style.layer, 200)
  }
  assert.equal(mapStyle(feature({ building: 'yes', name: 'Ordinary building' })).hallLabel, null)
})

test('subhall hyphen and colon tags share canonical codes, labels and closed-area recognition', () => {
  assert.deepEqual(hallCodes({ 'hall-e': ['1;2', '3'], 'hall:e': '1', 'hall-w': '２', 'hall-n': '1' }), ['E1', 'E2', 'E3', 'W2', 'N1'])
  assert.deepEqual(hallCodes({ 'hall-e': 'unknown', 'hall:w': '0' }), [])
  const area = buildOsmMap(nodes(), [{
    id: 'e1', refs: ['1', '2', '3', '4', '1'], tags: { 'hall-e': '1', 'tokyo-big-sight': 'yes' },
  }], []).features[0]
  assert.equal(area.area, true)
  assert.deepEqual(mapStyle(area).hallLabel, { text: '東1', color: '#b43a3a' })
  assert.equal(mapStyle(area).fill, 'rgba(238, 137, 137, 0.48)')
})

test('subhall areas cover same-level OSM geometry while other halls and orange buildings use lighter fills', () => {
  const base = { 'tokyo-big-sight': 'yes', building: 'yes', level: '1' }
  for (const key of ['hall-e', 'hall:w', 'hall-s']) {
    const hall = mapStyle(feature({ ...base, [key]: '1' }, true))
    for (const tags of [{ highway: 'footway' }, { highway: 'pedestrian' }, { railway: 'rail' }]) {
      assert.ok(compareMapStyles(mapStyle(feature({ ...base, ...tags }, true)), hall) < 0)
    }
    assert.ok(compareMapStyles(hall, mapStyle(feature({ ...base, level: '2' }, true))) < 0)
  }
  for (const [hall, fill] of [
    ['e', 'rgba(238, 137, 137, 0.28)'],
    ['w', 'rgba(136, 183, 248, 0.19)'],
    ['s', 'rgba(127, 228, 162, 0.16)'],
  ]) assert.equal(mapStyle(feature({ ...base, hall }, true)).fill, fill)
  assert.equal(mapStyle(feature(base, true)).fill, 'rgba(226, 132, 67, 0.08)')
  assert.equal(mapStyle(feature({ ...base, 'hall-e': '1' }, false)).layer, 20)
})

test('reference scope fades outside features but preserves tagged indoor and hall colors', () => {
  const outside = mapStyle(feature({ building: 'yes', hall: 'e' }, true))
  assert.equal(outside.fill, 'rgba(135, 139, 143, 0.18)')
  assert.equal(outside.stroke, 'rgba(116, 121, 125, 0.46)')
  const indoor = mapStyle(feature({ indoor: 'corridor', hall: 'w', 'tokyo-big-sight': 'yes' }))
  assert.equal(indoor.stroke, 'rgba(88, 126, 188, 0.54)')
  assert.equal(indoor.fill, null)
  const perimeter = mapStyle(feature({ 'tokyo-big-sight': 'yes' }, true))
  assert.equal(perimeter.fill, 'rgba(224, 104, 170, 0.12)')
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
  assert.equal(pedestrian.fill, 'rgb(210, 245, 242)')
  assert.equal(pedestrian.stroke, null)
  const bridge = mapStyle(feature({ ...base, highway: 'pedestrian', bridge: 'yes' }, true))
  assert.equal(bridge.strokeWidth, 1.25)
  assert.equal(bridge.layer, 101)
  const rail = mapStyle(feature({ ...base, railway: 'rail' }))
  assert.equal(rail.stroke, 'rgb(110, 145, 189)')
  assert.equal(rail.strokeWidth, 2.4)
  assert.deepEqual(rail.lineDash, [])
  const platform = mapStyle(feature({ ...base, railway: 'platform' }, true))
  assert.equal(platform.stroke, null)
  assert.equal(platform.fill, 'rgb(217, 219, 222)')
})

test('path styles composite onto white once and remain opaque without changing widths or dashes', () => {
  assert.equal(opaqueOnWhite('rgba(10, 20, 30, 0)'), 'rgb(255, 255, 255)')
  assert.equal(opaqueOnWhite('rgba(10, 20, 30, 1)'), 'rgb(10, 20, 30)')
  assert.equal(opaqueOnWhite('#00b86b'), '#00b86b')
  const base = { 'tokyo-big-sight': 'yes' }
  const footway = mapStyle(feature({ ...base, highway: 'footway' }))
  assert.equal(footway.stroke, 'rgb(137, 161, 148)')
  assert.equal(footway.strokeWidth, 0.9)
  const steps = mapStyle(feature({ ...base, highway: 'steps' }))
  assert.equal(steps.stroke, footway.stroke)
  assert.deepEqual(steps.lineDash, [1.2, 2.4])
  assert.equal(mapStyle(feature({ highway: 'footway' })).stroke, 'rgb(191, 193, 195)')
  assert.equal(mapStyle(feature({ ...base, highway: 'pedestrian', bridge: 'yes' }, true)).stroke, 'rgb(162, 210, 214)')
  for (const tags of [
    { highway: 'pedestrian' }, { railway: 'rail' }, { railway: 'station' },
    { railway: 'platform' }, { highway: 'cycleway' }, { pathway: 'yes' },
  ]) {
    const style = mapStyle(feature({ ...base, ...tags }, true))
    for (const color of [style.stroke, style.fill]) {
      if (color) assert.equal(color.startsWith('rgba'), false)
    }
    assert.equal(filteredLevelStyle(style).fill, null)
    assert.equal(filteredLevelStyle(style).stroke, filteredOutline)
  }
})

test('venue perimeter walls are gray while retaining boundary width, layer and filtered styling', () => {
  const wall = mapStyle(feature({ boundary: 'yes', 'tokyo-big-sight': 'yes' }))
  assert.equal(wall.stroke, 'rgba(116, 121, 125, 0.58)')
  assert.equal(wall.fill, null)
  assert.equal(wall.strokeWidth, 4)
  assert.equal(wall.layer, 4)
  assert.deepEqual(wall.lineDash, [])
  assert.equal(filteredLevelStyle(wall).stroke, filteredOutline)
  assert.equal(mapStyle(feature({ boundary: 'yes' })).stroke, 'rgba(116, 121, 125, 0.46)')
})

test('drawing order uses exact numeric level then type layer', () => {
  const low = mapStyle(feature({ level: '-1', highway: 'tertiary' }))
  const hall = mapStyle(feature({ level: '1', building: 'yes', 'hall:e': '1' }))
  const road = mapStyle(feature({ level: '0', highway: 'footway' }))
  const high = mapStyle(feature({ level: '2', building: 'yes' }))
  assert.equal(road.level, 0)
  assert.deepEqual([high, road, hall, low].sort(compareMapStyles), [low, road, hall, high])
})

test('objects without a level draw before level 1 regardless of type without acquiring a filter level', () => {
  const untagged = feature({ building: 'yes', 'hall-e': '1' }, true)
  const background = mapStyle(untagged)
  const firstFloor = mapStyle(feature({ level: '1' }, true))
  assert.equal(background.level, 0)
  assert.ok(background.layer > firstFloor.layer)
  assert.ok(compareMapStyles(background, firstFloor) < 0)
  assert.deepEqual(featureLevels(untagged.tags), [])
  assert.equal(matchesLevels(featureLevels(untagged.tags), new Set([0, 1])), false)
  assert.equal(matchesLevels(featureLevels(untagged.tags), new Set()), true)
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
