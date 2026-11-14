import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { booths, mapVacancies, mapVacancyRegions } from '../db/schema.js'
import type { MapRectangle } from '../db/schema.js'
import { mapGeometry, mapSlots, slotKey } from './mapGeometry.js'
import type { MapSlot } from './mapGeometry.js'
import { mergeVacancyRegions } from './regions.js'

export { mapSlots, slotKey }
export type { MapSlot }

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
  const source: unknown = JSON.parse(await readFile(file, 'utf8'))
  const geometry = mapGeometry(source)
  const slots = [...geometry.values()].map(({ bbox: _bbox, ...slot }) => slot)
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
    await transaction.delete(mapVacancyRegions).where(eq(mapVacancyRegions.event_id, eventId))
    for (let offset = 0; offset < missing.length; offset += 500) {
      await transaction.insert(mapVacancies).values(missing.slice(offset, offset + 500).map(slot => ({
        ...slot, event_id: eventId, comiket: circles[0]!.comiket, checked_at,
      })))
    }
    const days = [...new Set(circles.map(circle => circle.weekday))]
    const halls = [...new Set(slots.map(slot => slot.hall_group))]
    const grouped = new Map<string, MapRectangle[]>()
    for (const slot of missing) {
      const key = JSON.stringify([slot.weekday, slot.hall_group])
      const boxes = grouped.get(key) ?? []
      boxes.push(geometry.get(slotKey(slot))!.bbox)
      grouped.set(key, boxes)
    }
    const regions = days.flatMap(weekday => halls.map(hall_group => ({
      event_id: eventId, weekday, hall_group, checked_at,
      rectangles: mergeVacancyRegions(grouped.get(JSON.stringify([weekday, hall_group])) ?? []),
    })))
    await transaction.insert(mapVacancyRegions).values(regions)
    const result = { eventId, days: days.length, mapHalfBooths: slots.length, vacancies: missing.length,
      regions: regions.reduce((total, row) => total + row.rectangles.length, 0) }
    console.info('Map vacancy reconciliation completed:', result)
    return result
  })
}
