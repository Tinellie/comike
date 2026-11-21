import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHalls } from '../../client/src/map/halls.ts'
import { areaRoutePoint, boothRoutePoint, buildNavigation, shortestRoute } from '../../client/src/map/navigation.ts'
import { buildOsmMap } from '../../client/src/map/osm.ts'
import type { OsmFeature } from '../../client/src/map/osm.ts'
import { projectCoordinate } from '../../client/src/map/viewport.ts'

test('A* prefers a longer outdoor detour when its weight is lower', () => {
  const nodes = [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 11, y: 0 }]
  const edges = [
    { from: 0, to: 1, multiplier: 2 },
    { from: 1, to: 2, multiplier: 2 },
    { from: 1, to: 3, multiplier: 1 },
    { from: 3, to: 2, multiplier: 1 },
    { from: 2, to: 4, multiplier: 2 },
  ]
  const start = { edge: edges[0], point: { x: -0.5, y: 0 } }
  const end = { edge: edges[4], point: { x: 10.5, y: 0 } }
  assert.deepEqual(shortestRoute(nodes, edges, start, end)?.points,
    [start.point, nodes[1], nodes[3], nodes[2], end.point])
  assert.equal(shortestRoute(nodes, [edges[0], edges[4]], start, end), null)
  assert.equal(shortestRoute(nodes, edges, start, { edge: edges[0], point: { x: -0.25, y: 0 } })?.cost, 0.5)
})

test('navigation keeps tagged outside ways and Japanese connector relations, not ordinary roads', () => {
  const nodes = [1, 2, 3, 4].map(id => ({ id: String(id), lat: 35, lon: 139 + id * 0.001, tags: {} }))
  const data = buildOsmMap(nodes, [
    { id: 'outside', refs: ['1', '2'], tags: { 'outside-hall:e123': 'yes' } },
    { id: 'connector', refs: ['2', '3'], tags: {} },
    { id: 'ordinary', refs: ['3', '4'], tags: { highway: 'footway' } },
  ], [{
    id: 'route', tags: { name: '東-西連絡通路' }, members: [{ type: 'way', ref: 'connector', role: '' }],
  }])
  assert.deepEqual(data.navigationRoutes?.map(({ from, to }) => [from, to]), [['1', '2'], ['2', '3']])
})

test('one-way route points only connect forward, with a detour available in reverse', () => {
  const nodes = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }]
  const edge = { from: 0, to: 1, multiplier: 1, oneway: true }
  const start = { edge, point: { x: 2, y: 0 } }
  const end = { edge, point: { x: 8, y: 0 } }
  assert.equal(shortestRoute(nodes, [edge], start, end)?.cost, 6)
  assert.equal(shortestRoute(nodes, [edge], end, start), null)
  const detour = [
    { from: 1, to: 2, multiplier: 1 },
    { from: 2, to: 0, multiplier: 1 },
  ]
  assert.deepEqual(shortestRoute(nodes, [edge, ...detour], end, start)?.points,
    [end.point, nodes[1], nodes[2], nodes[0], start.point])
  assert.equal(shortestRoute(nodes, [edge, ...detour], { edge, point: nodes[0] },
    { edge: detour[1], point: nodes[2] })?.cost, Math.hypot(5, 5))
  assert.equal(shortestRoute(nodes, [edge, ...detour], { edge: detour[0], point: nodes[2] },
    { edge, point: nodes[1] })?.cost, Math.hypot(5, 5))
})

test('OSM way direction survives hall projection cuts and reversed node IDs', () => {
  const osmNodes = [
    { id: '9', lat: 0, lon: 0, tags: {} },
    { id: '2', lat: 0, lon: 0.001, tags: {} },
  ]
  const halls = parseHalls({ halls: [{
    name: 'East 1', textRotation: 0, islands: [],
    boundary: [{ x: 30, y: 10 }, { x: 50, y: 10 }, { x: 30, y: 20 }],
    labels: [{ id: 'east', text: '1', code: 'E1', pos: { x: 40, y: 15 } }],
    pathGraph: {
      nodes: [{ x: 40, y: 10 }, { x: 40, y: 20 }, { x: 50, y: 10 }],
      edges: [{ from: 0, to: 1, kind: 'indoor' }, { from: 0, to: 2, kind: 'perimeter' }],
    },
  }] })
  for (const oneway of ['yes', '-1', 'no']) {
    const data = buildOsmMap(osmNodes, [
      { id: 'outside', refs: ['9', '2'], tags: { oneway } },
    ], [{
      id: 'rim', tags: { 'outside-hall': 'e1' }, members: [{ type: 'way', ref: 'outside', role: '' }],
    }])
    const { nodes, edges, byHall } = buildNavigation(data, halls, { schemaVersion: 1, placements: [{
      hallIndex: 0, name: null, anchor: { latitude: 0, longitude: 0 },
      offset: halls[0].pivot, rotation: 0, scale: 1, aspectRatio: 1,
    }] }, () => 1)
    const [indoor] = byHall.get(0)!.edges
    const start = nodes[indoor.from], end = nodes[indoor.to]
    assert.equal(shortestRoute(nodes, edges, { edge: indoor, point: start }, { edge: indoor, point: end })?.cost,
      Math.hypot(end.x - start.x, end.y - start.y))
    const segment = data.navigationRoutes![0]
    const outside = edges.filter(({ from, to }) =>
      nodes[from].y === segment.start.y && nodes[to].y === segment.start.y)
    assert.equal(outside.length, 2)
    const left = { point: segment.start, edge: outside.find(edge => [edge.from, edge.to].includes(0))! }
    const right = { point: segment.end, edge: outside.find(edge => [edge.from, edge.to].includes(1))! }
    assert.equal(shortestRoute(nodes, edges, left, right) !== null, oneway !== '-1')
    assert.equal(shortestRoute(nodes, edges, right, left) !== null, oneway !== 'yes')
  }
})

test('booth endpoints retain the selected half center and facing-side approach', () => {
  const boundary = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
  const bbox = { x: 30, y: 2, width: 10, height: 10 }
  const halls = parseHalls({ halls: [{
    name: 'East 1', textRotation: 0, boundary,
    islands: [{ id: 'island', code: 'A', markers: [], blocks: [{
      id: 'block', bbox, booths: [{ id: 'booth', bbox, number: '1', split: { a: 'l', b: 'r' } }],
    }] }],
    pathGraph: {
      nodes: [{ x: 20, y: 22 }, { x: 60, y: 22 }],
      edges: [{ from: 0, to: 1, kind: 'indoor' }],
    },
  }] })
  const data = { features: [], places: [], warnings: [], outsideHallRoutes: new Map(),
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } }
  const graph = buildNavigation(data, halls, { schemaVersion: 1, placements: [{
    hallIndex: 0, name: null, anchor: { latitude: 0, longitude: 0 },
    offset: halls[0].pivot, rotation: 0, scale: 1, aspectRatio: 1,
  }] }, () => 1)
  const entry = graph.byHall.get(0)!
  const booth = halls[0].page.booths[0]
  const [left, right] = halls[0].page.halfBooths!.map(half =>
    boothRoutePoint(graph, 0, booth, half.bbox).target)
  assert.ok(left && right)
  for (const [endpoint, x] of [[left, 32.5], [right, 37.5]] as const) {
    assert.deepEqual(endpoint.origin, entry.toWorld({ x, y: 7 }))
    assert.deepEqual(endpoint.front, entry.toWorld({ x, y: 12 }))
    assert.deepEqual(endpoint.point, entry.toWorld({ x, y: 22 }))
  }
  assert.equal(shortestRoute(graph.nodes, graph.edges, left, right)?.cost, 5)
})

test('area endpoints prefer the hall floor, otherwise use the highest filtered floor', () => {
  const osmNodes = [
    { id: '1', lat: 0, lon: 0, tags: {} },
    { id: '2', lat: 0, lon: 0.001, tags: {} },
    { id: '3', lat: 0.0001, lon: 0, tags: {} },
    { id: '4', lat: 0.0001, lon: 0.001, tags: {} },
  ]
  const data = buildOsmMap(osmNodes, [
    { id: 'lower', refs: ['1', '2'], tags: { name: '連絡通路', level: '1', oneway: 'yes' } },
    { id: 'upper', refs: ['3', '4'], tags: { name: '連絡通路', level: '2' } },
  ], [])
  const graph = buildNavigation(data, [], { schemaVersion: 1, placements: [] }, () => 1)
  const bounds = { minX: 0, maxX: 100, minY: -20, maxY: 10 }
  const venue = { id: 'venue', bounds, area: true, tags: { 'tokyo-big-sight': 'yes', level: '1;2;3' },
    paths: [[{ x: 0, y: -20 }, { x: 100, y: -20 }, { x: 100, y: 10 }, { x: 0, y: 10 }]] }
  const origin = projectCoordinate(0.0001, 0.0004)
  const hall = { ...venue, id: 'hall', tags: { 'hall-e': '1', level: '1' } }
  const lower = areaRoutePoint(graph, [venue, hall], origin, new Set([1, 2]))?.target
  assert.ok(lower)
  assert.equal(lower.insideHall, true)
  assert.deepEqual(areaRoutePoint(graph, [hall, venue], origin, new Set([2]))?.target, lower)
  assert.deepEqual(lower.origin, origin)
  assert.equal(lower.point.y, graph.nodes[lower.edge.from].y)
  assert.notEqual(lower.point.y, origin.y)
  assert.ok(shortestRoute(graph.nodes, graph.edges, lower, { edge: lower.edge, point: graph.nodes[lower.edge.to] }))
  assert.equal(shortestRoute(graph.nodes, graph.edges, lower, { edge: lower.edge, point: graph.nodes[lower.edge.from] }), null)
  const destination = { x: 75, y: 5 }
  const end = areaRoutePoint(graph, [venue], destination, new Set([1]))?.target
  assert.ok(end)
  assert.deepEqual(end.origin, destination)
  assert.equal(end.edge, lower.edge)
  assert.deepEqual(shortestRoute(graph.nodes, graph.edges, lower, end)?.points, [lower.point, end.point])
  assert.equal(shortestRoute(graph.nodes, graph.edges, end, lower), null)
  const upper = areaRoutePoint(graph, [venue], origin, new Set([1, 2]))?.target
  assert.ok(upper)
  assert.equal(upper.insideHall, false)
  assert.equal(upper.point.y, origin.y)
  assert.ok(Math.abs(upper.point.x - origin.x) < 1e-9)
  assert.match(areaRoutePoint(graph, [venue], origin, new Set([1, 2, 3]))?.error ?? '', /没有可接入/)
  for (const tag of ['path:s-entry', 'path:e-entry', 'path:x-entry']) {
    const entry: OsmFeature = { ...venue, id: 'entry', tags: { 'tokyo-big-sight': 'yes', level: '1', [tag]: 'yes' } }
    assert.match(areaRoutePoint(graph, [venue, entry, hall], origin, new Set([1, 2]))?.error ?? '', /入口/)
    assert.deepEqual(areaRoutePoint(graph, [entry, venue], origin, new Set([1, 2]))?.target, upper)
  }
  const hole = [{ x: 40, y: -15 }, { x: 50, y: -15 }, { x: 50, y: -5 }, { x: 40, y: -5 }]
  assert.equal(areaRoutePoint(graph, [{ ...venue, paths: [...venue.paths, hole] }], origin, new Set()), null)
  assert.equal(areaRoutePoint(graph, [{ ...venue, area: false }], origin, new Set()), null)
  assert.equal(areaRoutePoint(graph, [venue], { x: 110, y: -5 }, new Set()), null)
})

test('venue-only shortcuts work outdoors and on mixed routes, but not between two hall points', () => {
  const osmNodes = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [-0.001, 0.0005]]
    .map(([lat, lon], i) => ({ id: String(i), lat, lon, tags: {} }))
  const data = buildOsmMap(osmNodes, [
    { id: 'connector', refs: ['0', '1', '2', '3'], tags: { name: '連絡通路', level: '1' } },
    { id: 'venue', refs: ['0', '3'], tags: { highway: 'footway', level: '1', 'tokyo-big-sight': 'yes', oneway: 'yes' } },
    { id: 'untagged', refs: ['0', '4'], tags: { highway: 'footway', level: '1' } },
    { id: 'polygon', refs: ['0', '3', '4', '0'], tags: { highway: 'pedestrian', level: '1', 'tokyo-big-sight': 'yes' } },
  ], [])
  const graph = buildNavigation(data, [], { schemaVersion: 1, placements: [] }, () => 1)
  assert.deepEqual(data.venueRoutes?.map(({ from, to }) => [from, to]), [['0', '3']])
  const area = (id: string, minX: number, maxX: number, tags: OsmFeature['tags']): OsmFeature => ({
    id, area: true, tags: { level: '1', ...tags }, bounds: { minX, maxX, minY: -10, maxY: 10 },
    paths: [[{ x: minX, y: -10 }, { x: maxX, y: -10 }, { x: maxX, y: 10 }, { x: minX, y: 10 }]],
  })
  const features = [
    area('venue', -10, 125, { 'tokyo-big-sight': 'yes' }),
    area('east', -2, 4, { 'hall-e': '1' }),
    area('west', 107, 114, { 'hall:w': '1' }),
  ]
  const levels = new Set([1])
  const insideStart = areaRoutePoint(graph, features, { x: 3, y: -1 }, levels)?.target
  const insideEnd = areaRoutePoint(graph, features, { x: 108, y: -1 }, levels)?.target
  const outsideStart = areaRoutePoint(graph, features, { x: 15, y: 1 }, levels)?.target
  const outsideEnd = areaRoutePoint(graph, features, { x: 95, y: 1 }, levels)?.target
  assert.ok(insideStart && insideEnd && outsideStart && outsideEnd)
  assert.equal(insideStart.insideHall, true)
  assert.equal(insideEnd.insideHall, true)
  assert.equal(outsideStart.insideHall, false)
  assert.ok(!insideStart.edge.venueOnly && !insideEnd.edge.venueOnly)
  assert.ok(outsideStart.edge.venueOnly && outsideEnd.edge.venueOnly)
  const route = (start: typeof insideStart, end: typeof insideEnd) => shortestRoute(graph.nodes, graph.edges, start, end)
  assert.ok((route(insideStart, insideEnd)?.cost ?? 0) > 300)
  assert.equal(route(outsideStart, outsideEnd)?.cost, 80)
  assert.ok((route(outsideEnd, outsideStart)?.cost ?? 0) > 300)
  const mixed = route(insideStart, outsideEnd)
  assert.ok(mixed && mixed.cost < 100)
})
