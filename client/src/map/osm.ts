import { projectCoordinate } from './viewport'
import type { Bounds, Point } from './viewport'

export type Tags = Record<string, string | string[]>

export function tagValues(tags: Tags, key: string): string[] {
  const value = tags[key]
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

export function featureLevels(tags: Tags): number[] {
  return [...new Set(tagValues(tags, 'level').flatMap(value => value.split(/[;,]/))
    .map(value => value.trim()).filter(value => value !== '').map(Number).filter(Number.isFinite))]
}

export function hallCodes(tags: Tags): string[] {
  return [...new Set(['e', 'w', 's', 'n'].flatMap(direction =>
    [`hall:${direction}`, `hall-${direction}`].flatMap(key =>
      tagValues(tags, key).flatMap(value => value.normalize('NFKC').split(/[;,]/))
        .map(value => value.trim()).filter(value => /^[1-9][0-9]?$/.test(value))
        .map(value => direction.toUpperCase() + value),
    ),
  ))]
}

export function mergeTags(...sources: Tags[]): Tags {
  const result: Tags = {}
  for (const source of sources) {
    for (const key of Object.keys(source)) {
      const values = [...new Set([...tagValues(result, key), ...tagValues(source, key)])]
      result[key] = values.length === 1 ? values[0] : values
    }
  }
  return result
}

export interface OsmNode {
  id: string
  lat: number
  lon: number
  tags: Tags
}

export interface OsmWay {
  id: string
  refs: string[]
  tags: Tags
}

export interface OsmRelation {
  id: string
  members: { type: string; ref: string; role: string }[]
  tags: Tags
}

export interface OsmFeature {
  id: string
  paths: Point[][]
  area: boolean
  tags: Tags
  bounds: Bounds
  polygonMember?: boolean
}

export interface OsmMapData {
  features: OsmFeature[]
  places: { point: Point; name: string }[]
  bounds: Bounds
  warnings: string[]
  outsideHallRoutes: ReadonlyMap<string, readonly OsmRouteSegment[]>
}

export interface OsmRouteSegment {
  from: string
  to: string
  start: Point
  end: Point
}

function boundsOf(paths: Point[][]): Bounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const path of paths) {
    for (const point of path) {
      bounds.minX = Math.min(bounds.minX, point.x)
      bounds.minY = Math.min(bounds.minY, point.y)
      bounds.maxX = Math.max(bounds.maxX, point.x)
      bounds.maxY = Math.max(bounds.maxY, point.y)
    }
  }
  return bounds
}

function isArea(tags: Tags, closed: boolean): boolean {
  const has = (key: string, value: string) => tagValues(tags, key).includes(value)
  if (!closed || has('area', 'no')) return false
  return has('area', 'yes') || Boolean(
    tags.building && !has('building', 'no') || tags['building:part'] && !has('building:part', 'no')
    || tags.landuse || tags.leisure && !has('leisure', 'track')
    || tagValues(tags, 'natural').some(value => ['water', 'wood', 'grassland', 'heath', 'scrub', 'beach'].includes(value))
    || has('amenity', 'parking') || has('railway', 'platform') || has('railway', 'station')
    || has('highway', 'pedestrian') || tags['tokyo-big-sight'] || hallCodes(tags).length,
  )
}

export function stitchRings(parts: string[][]): string[][] | null {
  const remaining = parts.map(part => [...part])
  const rings: string[][] = []
  while (remaining.length) {
    const ring = remaining.shift()!
    if (ring.length < 2) return null
    while (ring[0] !== ring.at(-1)) {
      const end = ring.at(-1)
      const index = remaining.findIndex(part => part[0] === end || part.at(-1) === end)
      if (index < 0) return null
      const next = remaining.splice(index, 1)[0]
      if (next[0] !== end) next.reverse()
      ring.push(...next.slice(1))
    }
    if (ring.length < 4) return null
    rings.push(ring)
  }
  return rings
}

export function buildOsmMap(nodes: OsmNode[], ways: OsmWay[], relations: OsmRelation[]): OsmMapData {
  const points = new Map<string, Point>()
  for (const node of nodes) {
    if (points.has(node.id)) throw new Error(`重复的 OSM Node：${node.id}`)
    points.set(node.id, projectCoordinate(node.lat, node.lon))
  }
  const wayById = new Map(ways.map(way => [way.id, way]))
  if (wayById.size !== ways.length) throw new Error('重复的 OSM Way ID')
  if (new Set(relations.map(relation => relation.id)).size !== relations.length) {
    throw new Error('重复的 OSM Relation ID')
  }
  const features: OsmFeature[] = []
  const polygonMembers = new Set<string>()
  const relationTags = new Map<string, Tags>()
  const outsideHallRoutes = new Map<string, OsmRouteSegment[]>()
  const outsideHallWays = new Map<string, Set<string>>()
  for (const relation of relations) {
    const keys = tagValues(relation.tags, 'outside-hall').map(value => value.trim().toLowerCase())
    if (!keys.length) {
      for (const name of tagValues(relation.tags, 'name')) {
        const key = /^(?:outside-hall|hall-outside)-([ewsn]\d+)$/i.exec(name.trim())?.[1]
        if (key) keys.push(key.toLowerCase())
      }
    }
    for (const member of relation.members) {
      if (member.type !== 'way') continue
      relationTags.set(member.ref, mergeTags(relationTags.get(member.ref) ?? {}, relation.tags))
      for (const key of keys) {
        let members = outsideHallWays.get(key)
        if (!members) outsideHallWays.set(key, members = new Set())
        members.add(member.ref)
      }
    }
  }
  for (const [key, members] of outsideHallWays) {
    const segments: OsmRouteSegment[] = []
    for (const id of members) {
      const refs = wayById.get(id)?.refs ?? []
      for (let i = 1; i < refs.length; i++) {
        const from = refs[i - 1], to = refs[i], start = points.get(from), end = points.get(to)
        if (start && end && (start.x !== end.x || start.y !== end.y)) segments.push({ from, to, start, end })
      }
    }
    outsideHallRoutes.set(key, segments)
  }
  let incompleteRelations = 0
  for (const relation of relations) {
    if (!tagValues(relation.tags, 'type').includes('multipolygon')) continue
    const outer: string[][] = []
    const inner: string[][] = []
    let incomplete = false
    for (const member of relation.members) {
      if (member.role && !['outer', 'inner'].includes(member.role)) continue
      const way = member.type === 'way' ? wayById.get(member.ref) : undefined
      if (!way || way.refs.some(ref => !points.has(ref))) {
        incomplete = true
        break
      }
      ;(member.role === 'inner' ? inner : outer).push(way.refs)
    }
    const outerRings = stitchRings(outer)
    const innerRings = stitchRings(inner)
    if (incomplete || !outerRings?.length || innerRings === null) {
      incompleteRelations += 1
      continue
    }
    const paths = [...outerRings, ...innerRings].map(ring => ring.map(ref => points.get(ref)!))
    const outerTags = relation.members
      .filter(member => member.type === 'way' && ['', 'outer'].includes(member.role))
      .map(member => wayById.get(member.ref)!.tags)
    features.push({
      id: `relation/${relation.id}`, paths, area: true,
      tags: mergeTags(relation.tags, ...outerTags), bounds: boundsOf(paths),
    })
    for (const member of relation.members) {
      if (member.type === 'way' && ['', 'outer', 'inner'].includes(member.role)) polygonMembers.add(member.ref)
    }
  }
  let missingReferences = 0
  for (const way of ways) {
    const paths: Point[][] = []
    let segment: Point[] = []
    let missing = false
    for (const ref of way.refs) {
      const point = points.get(ref)
      if (!point) {
        missingReferences += 1
        missing = true
        if (segment.length >= 2) paths.push(segment)
        segment = []
      } else {
        segment.push(point)
      }
    }
    if (segment.length >= 2) paths.push(segment)
    if (!paths.length) continue
    const closed = !missing && way.refs.length >= 4 && way.refs[0] === way.refs.at(-1)
    const tags = mergeTags(relationTags.get(way.id) ?? {}, way.tags)
    features.push({
      id: `way/${way.id}`, paths, tags, bounds: boundsOf(paths),
      area: !polygonMembers.has(way.id) && isArea(tags, closed),
      polygonMember: polygonMembers.has(way.id),
    })
  }
  if (!features.length) throw new Error('OSM 文件中没有可绘制的有效地图线段或区域')
  const warnings: string[] = []
  if (missingReferences) warnings.push(`${missingReferences} 处 Way 节点引用缺失，已断开对应线段，未跨越缺口连线。`)
  if (incompleteRelations) warnings.push(`${incompleteRelations} 个多边形关系不完整，未填充区域；保留可用成员线段。`)
  const bounds = boundsOf(features.map(feature => [
    { x: feature.bounds.minX, y: feature.bounds.minY },
    { x: feature.bounds.maxX, y: feature.bounds.maxY },
  ]))
  const places = nodes.filter(node => tagValues(node.tags, 'name').length).map(node => ({
    point: points.get(node.id)!, name: tagValues(node.tags, 'name')[0],
  }))
  return { features, places, bounds, warnings, outsideHallRoutes }
}

function attribute(element: Element, name: string): string {
  const value = element.getAttribute(name)
  if (value === null || value.trim() === '') throw new Error(`OSM ${element.tagName} 缺少 ${name}`)
  return value
}

function tagsOf(element: Element): Tags {
  return Object.fromEntries([...element.children]
    .filter(child => child.tagName === 'tag')
    .map(child => [attribute(child, 'k'), attribute(child, 'v')]))
}

export function parseOsm(xml: string): OsmMapData {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('OSM 文件不支持 DOCTYPE')
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.getElementsByTagName('parsererror').length || document.documentElement.tagName !== 'osm') {
    throw new Error('OSM XML 格式无效')
  }
  const nodes: OsmNode[] = []
  const ways: OsmWay[] = []
  const relations: OsmRelation[] = []
  for (const element of document.documentElement.children) {
    if (element.getAttribute('action') === 'delete' || element.getAttribute('visible') === 'false') continue
    if (!['node', 'way', 'relation'].includes(element.tagName)) continue
    const id = attribute(element, 'id')
    const tags = tagsOf(element)
    if (element.tagName === 'node') {
      nodes.push({ id, lat: Number(attribute(element, 'lat')), lon: Number(attribute(element, 'lon')), tags })
    } else if (element.tagName === 'way') {
      ways.push({
        id, tags, refs: [...element.children].filter(child => child.tagName === 'nd')
          .map(child => attribute(child, 'ref')),
      })
    } else {
      relations.push({
        id, tags, members: [...element.children].filter(child => child.tagName === 'member')
          .map(child => ({
            type: attribute(child, 'type'), ref: attribute(child, 'ref'), role: child.getAttribute('role') ?? '',
          })),
      })
    }
  }
  return buildOsmMap(nodes, ways, relations)
}
