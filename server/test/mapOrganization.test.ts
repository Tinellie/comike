import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { db, pool } from '../src/db/index.js'
import { booths, mapGenres, mapGenreRegions, mapVacancyRegions } from '../src/db/schema.js'
import { mapGeometry } from '../src/booths/mapGeometry.js'
import { genreKey, organizeMapGenres, projectGenres } from '../src/booths/genres.js'
import { reconcileMapVacancies } from '../src/booths/reconcile.js'
import { MysqlBoothRepository } from '../src/booths/repository.js'
import { parseHallGroups } from '../src/booths/catalog.js'

function mapData() {
  return { halls: [{ name: '東123', islands: [{ code: 'ア', blocks: [{ booths: [
    { id: 'm1', number: '01', bbox: { x: 0, y: 0, width: 20, height: 20 }, split: { a: 'l', b: 'r' } },
    { id: 'm2', number: '02', bbox: { x: 20, y: 0, width: 20, height: 20 }, split: { a: 'l', b: 'r' } },
  ] }] }] }] }
}

const circle = { id: '1', weekday: '土', hall: '東', island_code: 'ア', booth_number: '01',
  booth_suffix: 'a', genre: 'Alpha', genre_code: '001' }

test('genre projection splits a/b, unites neighbors, counts ab once and preserves codes and dates', () => {
  const geometry = mapGeometry(mapData())
  const projected = projectGenres(geometry, [
    circle, { ...circle, id: '2', booth_suffix: 'b', genre: 'Beta', genre_code: '002' },
    { ...circle, id: '3', booth_number: '02', booth_suffix: 'ab', genre: 'Beta', genre_code: '002' },
    { ...circle, id: '4', weekday: '日', booth_suffix: 'ab', genre: null, genre_code: null },
  ])
  assert.equal(projected.unmatched, 0)
  assert.deepEqual(projected.categories.map(row => [row.weekday, row.genre, row.genre_code, row.circle_count]),
    [['土', 'Alpha', '001', 1], ['土', 'Beta', '002', 2], ['日', null, null, 1]])
  assert.deepEqual(projected.regions.map(row => row.rectangles), [
    [{ x: 0, y: 0, width: 10, height: 20 }],
    [{ x: 10, y: 0, width: 30, height: 20 }],
    [{ x: 0, y: 0, width: 20, height: 20 }],
  ])
  assert.notEqual(genreKey(null, null), genreKey('', null))
  assert.notEqual(genreKey('A:B', 'C'), genreKey('B', 'C:A'))
  assert.throws(() => projectGenres(geometry, [circle, { ...circle, genre: 'Other' }]), /同一半格/)
  const invalid = mapData()
  invalid.halls[0]!.islands[0]!.blocks[0]!.booths[0]!.bbox.width = -1
  assert.throws(() => mapGeometry(invalid), /几何/)
})

test('MySQL organizers persist atomic ranges and counts, preserve colors and rollback conflicts',
  { skip: !db && 'Run with the server .env loaded' }, async t => {
    t.after(async () => { await pool!.end() })
    const directory = await mkdtemp(join(tmpdir(), 'comike-map-organization-'))
    t.after(() => rm(directory, { recursive: true }))
    const file = join(directory, 'map.json'), data = mapData()
    await writeFile(file, JSON.stringify(data))
    const eventId = `${Date.now()}${Math.floor(Math.random() * 1000)}`
    const rollback = new Error('Rollback synthetic organizers')
    await assert.rejects(db!.transaction(async transaction => {
      const base = { event_id: eventId, comiket: 9999, circle_name: 'test', images: '[]',
        source_url: 'https://example.invalid/', last_crawled_at: '2026-01-01 00:00:00' }
      await transaction.insert(booths).values([
        { ...base, ...circle, id: `${eventId}1` },
        { ...base, ...circle, id: `${eventId}2`, booth_suffix: 'b', genre: 'Beta', genre_code: '002' },
        { ...base, ...circle, id: `${eventId}3`, weekday: '日', booth_suffix: 'ab', genre: null, genre_code: null },
      ])
      const vacancies = await reconcileMapVacancies(file, eventId, transaction)
      assert.equal(vacancies.vacancies, 4)
      assert.equal(vacancies.regions, 2)
      const savedVacancies = await transaction.select().from(mapVacancyRegions).where(eq(mapVacancyRegions.event_id, eventId))
      assert.equal(savedVacancies.length, 2)
      assert.ok(savedVacancies.every(row => JSON.stringify(row.rectangles) === JSON.stringify([{ x: 20, y: 0, width: 20, height: 20 }])))
      await organizeMapGenres(file, eventId, transaction)
      const categories = await transaction.select().from(mapGenres).where(eq(mapGenres.event_id, eventId))
      assert.equal(categories.length, 3)
      assert.equal(new Set(categories.map(row => row.color)).size, 3)
      assert.ok(categories.every(row => row.circle_count === 1 && /^#[0-9a-f]{6}$/.test(row.color)))
      const colors = categories.map(row => [row.genre_key, row.color]).sort()
      await organizeMapGenres(file, eventId, transaction)
      assert.deepEqual((await transaction.select().from(mapGenres).where(eq(mapGenres.event_id, eventId)))
        .map(row => [row.genre_key, row.color]).sort(), colors)
      const repository = new MysqlBoothRepository(async () => parseHallGroups(data), transaction)
      const preload = await repository.mapData(eventId, '土')
      assert.equal(preload.genreReady, true)
      assert.equal(preload.vacancyReady, true)
      assert.equal(preload.genres.length, 2)
      assert.equal(preload.genreRegions.length, 2)
      assert.deepEqual(preload.vacancyRegions, [{ hallGroup: '東123', rectangles: savedVacancies[0]!.rectangles }])
      const before = await transaction.select().from(mapGenreRegions).where(eq(mapGenreRegions.event_id, eventId))
      await transaction.insert(booths).values({ ...base, ...circle, id: `${eventId}4`, genre: 'Conflict' })
      await assert.rejects(organizeMapGenres(file, eventId, transaction), /同一半格/)
      assert.deepEqual(await transaction.select().from(mapGenreRegions).where(eq(mapGenreRegions.event_id, eventId)), before)
      await writeFile(file, '{"halls":[]}')
      await assert.rejects(reconcileMapVacancies(file, eventId, transaction), /Hall/)
      assert.deepEqual(await transaction.select().from(mapVacancyRegions).where(eq(mapVacancyRegions.event_id, eventId)), savedVacancies)
      throw rollback
    }), error => error === rollback)
    assert.equal((await db!.select().from(mapGenres).where(eq(mapGenres.event_id, eventId))).length, 0)
  })
