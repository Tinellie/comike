import type { MapRectangle } from '../db/schema.js'
type Box = MapRectangle

export function mergeVacancyRegions(boxes: readonly Box[]): Box[] {
  const edges = [...new Set(boxes.flatMap(box => [box.y, box.y + box.height]))].sort((a, b) => a - b)
  const regions: Box[] = []
  let previous = new Map<string, Box>()
  for (let i = 0; i + 1 < edges.length; i++) {
    const y = edges[i]!, bottom = edges[i + 1]!
    const intervals = boxes.filter(box => box.y < bottom && box.y + box.height > y)
      .map(box => ({ left: box.x, right: box.x + box.width })).sort((a, b) => a.left - b.left)
    const spans: typeof intervals = []
    for (const interval of intervals) {
      const last = spans.at(-1)
      if (last && interval.left <= last.right) last.right = Math.max(last.right, interval.right)
      else spans.push({ ...interval })
    }
    const current = new Map<string, Box>()
    for (const { left, right } of spans) {
      const key = `${left}:${right}`
      const above = previous.get(key)
      if (above) {
        above.height = bottom - above.y
        current.set(key, above)
      } else {
        const region = { x: left, y, width: right - left, height: bottom - y }
        regions.push(region)
        current.set(key, region)
      }
    }
    previous = current
  }
  return regions
}
