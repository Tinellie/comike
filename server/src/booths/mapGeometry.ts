import { parseHallGroups } from './catalog.js'
import type { MapRectangle } from '../db/schema.js'

export interface MapSlot {
  hall: string
  hall_group: string
  island_code: string
  booth_number: string
  booth_suffix: 'a' | 'b'
  map_booth_id: string
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('地图位置对象无效')
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('地图位置列表无效')
  return value
}

export function slotKey(slot: { hall: string; island_code: string; booth_number: string; booth_suffix: string }) {
  return JSON.stringify([slot.hall, slot.island_code.normalize('NFKC'), slot.booth_number.padStart(2, '0'), slot.booth_suffix])
}

export function mapSlots(value: unknown): MapSlot[] {
  parseHallGroups(value)
  const slots: MapSlot[] = []
  const keys = new Set<string>()
  let skipped = 0
  for (const rawHall of array(object(value).halls)) {
    const hall = object(rawHall), name = String(hall.name)
    for (const rawIsland of array(hall.islands)) {
      const island = object(rawIsland)
      for (const rawBlock of array(island.blocks)) {
        for (const rawBooth of array(object(rawBlock).booths)) {
          const booth = object(rawBooth)
          if (island.code === null || booth.number === null || booth.split === null) { skipped++; continue }
          if (typeof booth.id !== 'string' || !booth.id || booth.id.length > 128
            || typeof booth.number !== 'string' || !/^\d{1,2}$/.test(booth.number)) throw new Error('地图摊位编号无效')
          const split = object(booth.split)
          const opposite: Record<string, string> = { l: 'r', r: 'l', t: 'b', b: 't' }
          if (typeof split.a !== 'string' || opposite[split.a] !== split.b) throw new Error('地图半摊位分割无效')
          for (const suffix of ['a', 'b'] as const) {
            const slot: MapSlot = {
              hall: name[0]!, hall_group: name, island_code: String(island.code).normalize('NFKC'),
              booth_number: booth.number.padStart(2, '0'), booth_suffix: suffix, map_booth_id: booth.id,
            }
            const key = slotKey(slot)
            if (keys.has(key)) throw new Error(`地图位置重复：${key}`)
            keys.add(key); slots.push(slot)
          }
        }
      }
    }
  }
  if (skipped) console.warn(`Map reconciliation skipped ${skipped} cells without recognized island/booth numbers or half splits`)
  if (!slots.length) throw new Error('地图没有可比对的位置')
  return slots
}

export function mapGeometry(value: unknown) {
  const slots = mapSlots(value)
  const boxes = new Map<string, MapRectangle>()
  for (const rawHall of array(object(value).halls)) for (const rawIsland of array(object(rawHall).islands)) {
    for (const rawBlock of array(object(rawIsland).blocks)) for (const rawBooth of array(object(rawBlock).booths)) {
      const booth = object(rawBooth)
      if (booth.split === null || object(rawIsland).code === null || booth.number === null) continue
      const split = object(booth.split), rawBox = object(booth.bbox)
      const { x, y, width, height } = rawBox
      if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') throw new Error('地图格子坐标无效')
      const b = { x, y, width, height }
      if (![b.x, b.y, b.width, b.height].every(Number.isFinite)
        || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0) throw new Error(`地图格子几何无效：${booth.id}`)
      for (const suffix of ['a', 'b'] as const) {
        const side = split[suffix], horizontal = side === 'l' || side === 'r'
        boxes.set(JSON.stringify([object(rawHall).name, booth.id, suffix]), {
          x: b.x + (side === 'r' ? b.width / 2 : 0), y: b.y + (side === 'b' ? b.height / 2 : 0),
          width: horizontal ? b.width / 2 : b.width, height: horizontal ? b.height : b.height / 2,
        })
      }
    }
  }
  return new Map(slots.map(slot => {
    const bbox = boxes.get(JSON.stringify([slot.hall_group, slot.map_booth_id, slot.booth_suffix]))
    if (!bbox) throw new Error(`地图位置缺少几何：${slot.map_booth_id}`)
    return [slotKey(slot), { ...slot, bbox }]
  }))
}
