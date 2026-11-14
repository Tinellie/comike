import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { booths, mapVacancies } from '../db/schema.js'
import { parseHallGroups } from './catalog.js'

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

export function mapSlots(value: unknown): MapSlot[] {
  parseHallGroups(value)
  const slots: MapSlot[] = []
  const keys = new Set<string>()
  let skipped = 0
  for (const rawHall of array(object(value).halls)) {
    const hall = object(rawHall)
    const name = String(hall.name)
    for (const rawIsland of array(hall.islands)) {
      const island = object(rawIsland)
      for (const rawBlock of array(island.blocks)) {
        for (const rawBooth of array(object(rawBlock).booths)) {
          const booth = object(rawBooth)
          if (island.code === null || booth.number === null || booth.split === null) { skipped++; continue }
          if (typeof booth.id !== 'string' || !booth.id || booth.id.length > 128
            || typeof booth.number !== 'string' || !/^\d{1,2}$/.test(booth.number)) throw new Error('地图摊位编号无效')
          if (booth.split !== null) {
            const split = object(booth.split)
            const opposite: Record<string, string> = { l: 'r', r: 'l', t: 'b', b: 't' }
            if (typeof split.a !== 'string' || opposite[split.a] !== split.b) throw new Error('地图半摊位分割无效')
          }
          for (const suffix of ['a', 'b'] as const) {
            const slot: MapSlot = {
              hall: name[0]!, hall_group: name, island_code: String(island.code).normalize('NFKC'),
              booth_number: booth.number.padStart(2, '0'), booth_suffix: suffix, map_booth_id: booth.id,
            }
            const key = slotKey(slot)
            if (keys.has(key)) throw new Error(`地图位置重复：${key}`)
            keys.add(key)
            slots.push(slot)
          }
        }
      }
    }
  }
  if (skipped) console.warn(`Map reconciliation skipped ${skipped} cells without recognized island/booth numbers or half splits`)
  if (!slots.length) throw new Error('地图没有可比对的位置')
  return slots
}

function slotKey(slot: { hall: string; island_code: string; booth_number: string; booth_suffix: string }) {
  return JSON.stringify([slot.hall, slot.island_code.normalize('NFKC'), slot.booth_number.padStart(2, '0'), slot.booth_suffix])
}

export function missingSlots(slots: MapSlot[], circles: {
  weekday: string; hall: string; island_code: string; booth_number: string; booth_suffix: string | null
}[]) {
  const days = [...new Set(circles.map(circle => circle.weekday))]
  const occupied = new Set<string>()
  let unknownSuffixes = 0
  for (const circle of circles) {
    if (!['a', 'b', 'ab', '', null].includes(circle.booth_suffix)) throw new Error('社团摊位后缀无效')
    if (!circle.booth_suffix) { unknownSuffixes++; continue }
    const suffixes = circle.booth_suffix === 'a' || circle.booth_suffix === 'b' ? [circle.booth_suffix] : ['a', 'b']
    for (const suffix of suffixes) occupied.add(JSON.stringify([circle.weekday, slotKey({ ...circle, booth_suffix: suffix })]))
  }
  if (unknownSuffixes) console.warn(`Map reconciliation could not match ${unknownSuffixes} circles without an a/b/ab suffix`)
  return days.flatMap(weekday => slots.filter(slot => !occupied.has(JSON.stringify([weekday, slotKey(slot)])))
    .map(slot => ({ ...slot, weekday })))
}

export async function reconcileMapVacancies(
  file: string, eventId: string, connection: Pick<NonNullable<typeof db>, 'transaction'> | undefined = db,
) {
  if (!connection) throw new Error('DATABASE_URL is not configured')
  const slots = mapSlots(JSON.parse(await readFile(file, 'utf8')))
  return connection.transaction(async transaction => {
    const circles = await transaction.select({
      weekday: booths.weekday, hall: booths.hall, island_code: booths.island_code,
      booth_number: booths.booth_number, booth_suffix: booths.booth_suffix, comiket: booths.comiket,
    }).from(booths).where(eq(booths.event_id, eventId))
    if (!circles.length) throw new Error('活动没有社团数据，无法确定日目并执行比对')
    const editions = new Set(circles.map(circle => circle.comiket))
    if (editions.size !== 1) throw new Error('活动包含不同届数，拒绝比对地图')
    const missing = missingSlots(slots, circles)
    const checked_at = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await transaction.delete(mapVacancies).where(eq(mapVacancies.event_id, eventId))
    for (let offset = 0; offset < missing.length; offset += 500) {
      await transaction.insert(mapVacancies).values(missing.slice(offset, offset + 500).map(slot => ({
        ...slot, event_id: eventId, comiket: circles[0]!.comiket, checked_at,
      })))
    }
    const result = { eventId, days: new Set(circles.map(circle => circle.weekday)).size, mapHalfBooths: slots.length, vacancies: missing.length }
    console.info('Map vacancy reconciliation completed:', result)
    return result
  })
}
