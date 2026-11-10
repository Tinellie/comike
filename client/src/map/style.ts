import { tagValues } from './osm'
import type { OsmFeature, Tags } from './osm'
import type { Point } from './viewport'

export const mapBackground = '#f6f4ef'
export const gridColor = 'rgba(80, 87, 90, 0.12)'

export interface MapStyle {
  stroke: string | null
  fill: string | null
  strokeWidth: number
  lineDash: number[]
  level: number
  layer: number
  hallLabel: { text: string; color: string } | null
}

function has(tags: Tags, key: string, value?: string): boolean {
  const values = tagValues(tags, key)
  return value === undefined ? values.length > 0 : values.includes(value)
}

export function hallLabel(tags: Tags): MapStyle['hallLabel'] {
  for (const [key, prefix, color] of [
    ['hall:e', '東', '#b43a3a'], ['hall:w', '西', '#2a57ad'], ['hall:s', '南', '#2f8a4d'],
  ]) {
    const value = tagValues(tags, key).find(item => item.trim())
    if (value) return { text: prefix + value.trim(), color }
  }
  return null
}

export function mapStyle(feature: OsmFeature): MapStyle {
  const tags = feature.tags
  const levelValue = tagValues(tags, 'level').map(Number).find(Number.isFinite) ?? 1
  const level = levelValue === 0 ? 1 : levelValue
  const building = has(tags, 'building') || has(tags, 'building:part')
  const indoor = has(tags, 'indoor')
  const label = building || indoor ? hallLabel(tags) : null
  const style: MapStyle = {
    stroke: 'rgba(117, 121, 126, 0.5)',
    fill: has(tags, 'tokyo-big-sight') && feature.area ? 'rgba(224, 104, 170, 0.24)' : null,
    strokeWidth: 0.75, lineDash: [], level,
    layer: has(tags, 'tokyo-big-sight') && feature.area ? -5 : -20, hallLabel: null,
  }
  if (has(tags, 'highway', 'pedestrian')) {
    const elevated = has(tags, 'bridge') || level > 1
    Object.assign(style, {
      stroke: elevated ? 'rgba(52, 158, 166, 0.46)' : null,
      fill: 'rgba(122, 225, 218, 0.34)', strokeWidth: elevated ? 1.25 : 0, layer: elevated ? 101 : 100,
    })
  } else if (has(tags, 'highway', 'tertiary')) {
    Object.assign(style, { stroke: '#b4b8bd', fill: null, strokeWidth: 10, layer: 100 })
  } else if (has(tags, 'highway', 'footway') || has(tags, 'highway', 'steps')) {
    const steps = has(tags, 'highway', 'steps')
    Object.assign(style, {
      stroke: Object.keys(tags).some(key => /^path:.+/.test(key)) ? '#00b86b' : 'rgba(91, 124, 107, 0.72)',
      fill: null, strokeWidth: steps ? 1.05 : 0.9, lineDash: steps ? [1.2, 2.4] : [], layer: 102,
    })
  } else if (has(tags, 'railway', 'light_rail') || has(tags, 'railway', 'rail')) {
    Object.assign(style, { stroke: 'rgba(42, 93, 158, 0.68)', fill: null, strokeWidth: 2.4, layer: 3 })
  } else if (has(tags, 'railway', 'station')) {
    Object.assign(style, { stroke: '#aa8a4c', fill: 'rgba(236, 215, 166, 0.74)', strokeWidth: 1.2, layer: 1 })
  } else if (has(tags, 'railway', 'platform')) {
    Object.assign(style, { stroke: null, fill: 'rgba(120, 128, 136, 0.28)', strokeWidth: 0, layer: 1 })
  } else if (building || indoor) {
    let stroke = 'rgba(174, 94, 42, 0.54)'
    let fill = 'rgba(226, 132, 67, 0.14)'
    if (has(tags, 'hall', 'e')) {
      stroke = 'rgba(192, 104, 104, 0.54)'
      fill = 'rgba(238, 137, 137, 0.57)'
    } else if (has(tags, 'hall', 'w')) {
      stroke = 'rgba(88, 126, 188, 0.54)'
      fill = 'rgba(136, 183, 248, 0.38)'
    } else if (has(tags, 'hall', 's')) {
      stroke = 'rgba(93, 156, 122, 0.54)'
      fill = 'rgba(127, 228, 162, 0.32)'
    }
    Object.assign(style, {
      stroke, fill: building ? fill : null, strokeWidth: label ? 1.05 : 0.85,
      layer: label ? 20 : 0, hallLabel: feature.polygonMember ? null : label,
    })
  } else if (has(tags, 'boundary')) {
    Object.assign(style, { stroke: 'rgba(177, 128, 219, 0.58)', fill: null, strokeWidth: 4, layer: 4 })
  }
  if (!has(tags, 'tokyo-big-sight')) {
    if (style.stroke) style.stroke = 'rgba(116, 121, 125, 0.46)'
    if (style.fill) style.fill = 'rgba(135, 139, 143, 0.18)'
  }
  if (feature.polygonMember) {
    style.fill = null
    style.hallLabel = null
    if (!has(tags, 'highway') && !has(tags, 'railway')) style.stroke = null
  }
  return style
}

export function compareMapStyles(left: MapStyle, right: MapStyle): number {
  return left.level - right.level || left.layer - right.layer
}

export function onewayTriangles(paths: Point[][], tags: Tags, metersPerUnit: number): Point[][] {
  const values = tagValues(tags, 'oneway').map(value => value.toLowerCase())
  const direction = values.some(value => ['-1', 'reverse'].includes(value)) ? -1
    : values.some(value => ['yes', 'true', '1'].includes(value)) ? 1 : 0
  if (!direction) return []
  const rail = has(tags, 'railway', 'rail') || has(tags, 'railway', 'light_rail')
  const interval = 30 / metersPerUnit
  const arrowSize = (rail ? 3.4 : 5.1) / metersPerUnit
  const triangles: Point[][] = []
  for (const path of paths) {
    const points = direction === -1 ? [...path].reverse() : path
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]
      const end = points[index]
      const length = Math.hypot(end.x - start.x, end.y - start.y)
      if (length < interval * 0.6) continue
      const ux = (end.x - start.x) / length
      const uy = (end.y - start.y) / length
      for (let distance = interval * 0.5; distance < length; distance += interval) {
        const x = start.x + ux * distance
        const y = start.y + uy * distance
        triangles.push([
          { x, y },
          { x: x - ux * arrowSize - uy * arrowSize * 0.45, y: y - uy * arrowSize + ux * arrowSize * 0.45 },
          { x: x - ux * arrowSize + uy * arrowSize * 0.45, y: y - uy * arrowSize - ux * arrowSize * 0.45 },
        ])
      }
    }
  }
  return triangles
}
