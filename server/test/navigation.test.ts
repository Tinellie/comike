import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHalls } from '../../client/src/map/halls.ts'
import { buildNavigation, shortestRoute } from '../../client/src/map/navigation.ts'
import { buildOsmMap } from '../../client/src/map/osm.ts'

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
    }] })
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
