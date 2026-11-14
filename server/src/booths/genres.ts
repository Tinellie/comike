import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { booths, mapGenreRegions, mapGenres } from '../db/schema.js'
import type { MapRectangle } from '../db/schema.js'
import { mapGeometry, slotKey } from './mapGeometry.js'
import { mergeVacancyRegions } from './regions.js'

type Circle = Pick<typeof booths.$inferSelect,
  'id' | 'weekday' | 'hall' | 'island_code' | 'booth_number' | 'booth_suffix' | 'genre' | 'genre_code'>

export function genreKey(genre: string | null, code: string | null) {
  return `${code?.length ?? -1}:${code ?? ''}:${genre === null ? '-1:' : `${genre.length}:${genre}`}`
}

export function projectGenres(geometry: ReturnType<typeof mapGeometry>, circles: Circle[]) {
  const categories = new Map<string, { weekday: string; genre_key: string; genre: string | null; genre_code: string | null; circle_count: number }>()
  const occupied = new Map<string, string>()
  const groups = new Map<string, { weekday: string; hall_group: string; genre_key: string; boxes: MapRectangle[] }>()
  let unmatched = 0
  for (const circle of circles) {
    const key = genreKey(circle.genre, circle.genre_code)
    const suffixes = circle.booth_suffix === 'ab' ? ['a', 'b'] : circle.booth_suffix === 'a' || circle.booth_suffix === 'b' ? [circle.booth_suffix] : []
    let matched = false
    for (const booth_suffix of suffixes) {
      const location = slotKey({ ...circle, booth_suffix })
      const cell = geometry.get(location)
      if (!cell) continue
      matched = true
      const occupiedKey = JSON.stringify([circle.weekday, location])
      const previous = occupied.get(occupiedKey)
      if (previous !== undefined && previous !== key) throw new Error(`同一半格存在不同 genre：${circle.weekday} ${cell.hall_group}${cell.island_code}${cell.booth_number}${booth_suffix}`)
      if (previous !== undefined) continue
      occupied.set(occupiedKey, key)
      const groupKey = JSON.stringify([circle.weekday, cell.hall_group, key])
      const group = groups.get(groupKey) ?? { weekday: circle.weekday, hall_group: cell.hall_group, genre_key: key, boxes: [] }
      group.boxes.push(cell.bbox)
      groups.set(groupKey, group)
    }
    if (!matched) { unmatched++; continue }
    const categoryKey = JSON.stringify([circle.weekday, key])
    const category = categories.get(categoryKey) ?? {
      weekday: circle.weekday, genre_key: key, genre: circle.genre, genre_code: circle.genre_code, circle_count: 0,
    }
    category.circle_count++
    categories.set(categoryKey, category)
  }
  if (unmatched) console.warn(`Genre organization skipped ${unmatched} circles without a matched map half-booth`)
  return {
    categories: [...categories.values()],
    regions: [...groups.values()].map(({ boxes, ...group }) => ({ ...group, rectangles: mergeVacancyRegions(boxes) })),
    unmatched,
  }
}

function palette(index: number) {
  const hue = (index * 137.507764) % 360
  const component = (n: number) => {
    const k = (n + hue / 30) % 12
    return Math.round(255 * (0.62 - 0.28 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0')
  }
  return `#${component(0)}${component(8)}${component(4)}`
}

export async function organizeMapGenres(
  file: string, eventId: string, connection: Pick<NonNullable<typeof db>, 'transaction'> | undefined = db,
) {
  if (!connection) throw new Error('DATABASE_URL is not configured')
  const geometry = mapGeometry(JSON.parse(await readFile(file, 'utf8')))
  return connection.transaction(async transaction => {
    const circles = await transaction.select({
      id: booths.id, weekday: booths.weekday, hall: booths.hall, island_code: booths.island_code,
      booth_number: booths.booth_number, booth_suffix: booths.booth_suffix, genre: booths.genre, genre_code: booths.genre_code,
    }).from(booths).where(eq(booths.event_id, eventId))
    if (!circles.length) throw new Error('活动没有社团数据，无法整理 genre')
    const projected = projectGenres(geometry, circles)
    if (!projected.categories.length) throw new Error('没有匹配地图的 genre，拒绝替换已有数据')
    const previous = await transaction.select({ key: mapGenres.genre_key, color: mapGenres.color })
      .from(mapGenres).where(eq(mapGenres.event_id, eventId))
    const colors = new Map(previous.map(row => [row.key, row.color]))
    const used = new Set(colors.values())
    let next = 0
    for (const key of [...new Set(projected.categories.map(category => category.genre_key))].sort()) {
      if (colors.has(key)) continue
      let color: string
      do { color = palette(next++) } while (used.has(color))
      colors.set(key, color)
      used.add(color)
    }
    const checked_at = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await transaction.delete(mapGenreRegions).where(eq(mapGenreRegions.event_id, eventId))
    await transaction.delete(mapGenres).where(eq(mapGenres.event_id, eventId))
    const categories = projected.categories.map(row => ({ ...row, event_id: eventId, color: colors.get(row.genre_key)!, checked_at }))
    const regions = projected.regions.map(row => ({ ...row, event_id: eventId }))
    for (let i = 0; i < categories.length; i += 250) await transaction.insert(mapGenres).values(categories.slice(i, i + 250))
    for (let i = 0; i < regions.length; i += 250) await transaction.insert(mapGenreRegions).values(regions.slice(i, i + 250))
    const result = { eventId, genres: colors.size, groups: regions.length,
      rectangles: regions.reduce((total, row) => total + row.rectangles.length, 0), unmatched: projected.unmatched }
    console.info('Map genre organization completed:', result)
    return result
  })
}
