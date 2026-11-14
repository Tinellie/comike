import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { count, eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { BoothFilterError, eventDays, hallGroup, parseBoothQuery, parseHallGroups } from '../src/booths/catalog.js'
import { nameReading } from '../src/booths/reading.js'
import { MysqlBoothRepository } from '../src/booths/repository.js'
import type { BoothStore } from '../src/booths/repository.js'
import { db, pool } from '../src/db/index.js'
import { booths } from '../src/db/schema.js'
import type { Booth } from '../src/db/schema.js'

const groups = parseHallGroups({ halls: [
  { name: '東123', islands: [{ code: 'ア' }] },
  { name: '東7', islands: [{ code: 'A' }] },
  { name: '西12', islands: [{ code: 'あ' }] },
  { name: '南12', islands: [{ code: 'a' }] },
] })

test('hall groups use the actual map and preserve Latin case and kana distinctions', async () => {
  const actual = parseHallGroups(JSON.parse(await readFile(
    new URL('../../tools/booth-recognition/output/official-map/final.json', import.meta.url), 'utf8',
  )))
  assert.equal(hallGroup(actual, '東', 'ア'), '東123')
  assert.equal(hallGroup(actual, '東', 'Ａ'), '東7')
  assert.equal(hallGroup(actual, '西', 'あ'), '西12')
  assert.equal(hallGroup(actual, '南', 'a'), '南12')
  assert.equal(hallGroup(actual, '東', 'a'), '東（未匹配）')
  assert.equal(hallGroup(actual, '南', 'A'), '南（未匹配）')
  assert.equal(hallGroup(actual, '西', 'ア'), '西（未匹配）')
  assert.throws(() => parseHallGroups({ halls: [{ name: '東123', islands: [{ code: 'A' }, { code: 'Ａ' }] }] }), /重复/)
  assert.throws(() => parseHallGroups({ halls: [] }), /Hall/)
})

test('event days infer consecutive dates across the Sunday boundary and report ambiguity', () => {
  assert.deepEqual(eventDays(['水', '火', '火']).days.map(day => [day.weekday, day.label]),
    [['火', '一日目'], ['水', '二日目']])
  assert.deepEqual(eventDays(['月', '日', '土']).days.map(day => day.weekday), ['土', '日', '月'])
  assert.deepEqual(eventDays([]), { days: [], warning: null })
  assert.match(eventDays(['月', '水', '金', '日']).warning ?? '', /无法唯一推断/)
  assert.throws(() => eventDays(['x']), /曜日/)
})

test('list queries are bounded, strict and distinguish all from no selected filters', () => {
  const parse = (query: string) => parseBoothQuery(new URLSearchParams(query))
  assert.deepEqual(parse('eventId=240'), {
    eventId: '240', offset: 0, limit: 40, sort: 'location', direction: 'asc', days: null, halls: null, genres: null,
  })
  assert.deepEqual(parse('eventId=240&days=&halls=').days, [])
  assert.deepEqual(parse('eventId=240&days=土,日,土').days, ['土', '日'])
  assert.equal(parse('eventId=240&sort=genre').sort, 'genre')
  const genreQuery = (values: unknown) => `eventId=240&genres=${encodeURIComponent(JSON.stringify(values))}`
  assert.deepEqual(parse(genreQuery(['Alpha,Two', null, '', 'Alpha,Two'])).genres, ['Alpha,Two', null, ''])
  assert.deepEqual(parse(genreQuery([])).genres, [])
  for (const invalid of [null, 'test', [1], ['a'.repeat(256)], Array(513).fill('test')]) {
    assert.throws(() => parse(genreQuery(invalid)))
  }
  assert.throws(() => parse('eventId=240&genres=invalid'))
  for (const invalid of ['', 'eventId=x', 'eventId=240&limit=101', 'eventId=240&offset=-1',
    'eventId=240&limit=1.5', 'eventId=240&offset=1000001', 'eventId=240&sort=id',
    'eventId=240&direction=no', 'eventId=240&limit=1&limit=2', 'eventId=240&foo=1',
    'eventId=240&days=星期六', 'eventId=240&halls=东123']) {
    assert.throws(() => parse(invalid), undefined, invalid)
  }
})

test('automatic name readings normalize kanji, katakana and full-width English', async () => {
  assert.equal(await nameReading('東京ＡＢＣカタカナ'), 'とうきょうabcかたかな')
  assert.equal(await nameReading('ひらがな'), 'ひらがな')
})

test('booth HTTP routes validate requests and expose only fixed image paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-booths-test-'))
  await mkdir(join(directory, 'booths', 'c109'), { recursive: true })
  const image = Buffer.from('test-image')
  await writeFile(join(directory, 'booths', 'c109', '24001_1.png'), image)
  const store: BoothStore = {
    async options(eventId) {
      if (eventId === '999') throw new Error('test database unavailable')
      return eventId ? null : { event: null, events: [], days: [], halls: [], genres: [], warnings: [] }
    },
    async list(query) {
      if (query.days?.includes('月')) throw new BoothFilterError('筛选项不属于当前活动')
      return query.eventId === '240' ? { items: [], total: 0, nextOffset: null } : null
    },
    async detail() { return null },
  }
  const server = createApp({ checkDatabase: async () => {}, boothStore: store, mediaRoot: directory }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true })
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/booths`
  const page = await fetch(`${base}?eventId=240`)
  assert.deepEqual(await page.json(), { items: [], total: 0, nextOffset: null })
  assert.equal(page.headers.get('cache-control'), 'no-store')
  const options = await fetch(`${base}/options`)
  assert.equal(options.status, 200)
  assert.deepEqual(await options.json(), { event: null, events: [], days: [], halls: [], genres: [], warnings: [] })
  for (const [path, status] of [
    ['', 400], ['?eventId=240&limit=101', 400], ['?eventId=240&days=月', 400],
    ['?eventId=241', 404], ['/options?eventId=241', 404], ['/options?eventId=999', 503],
    ['/options?eventId=240&eventId=241', 400], ['/options?foo=1', 400],
    ['/invalid', 400], ['/24001', 404], ['/images/c109/24001_0.png', 400],
    ['/images/c109/%2e%2e%2fsecret.png', 400], ['/images/c109/24001_2.png', 404],
    ['/images/c0/24001_1.png', 400],
  ] as const) {
    const response = await fetch(base + path)
    assert.equal(response.status, status, path)
    assert.match(response.headers.get('content-type') ?? '', /json/, path)
  }
  const response = await fetch(`${base}/images/c109/24001_1.png`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)
})

test('MySQL sorts, filters and paginates actual booth rows without changing existing data',
  { skip: !db && 'Run with the server .env loaded for the MySQL integration check' }, async t => {
    const connection = db!
    t.after(async () => { await pool!.end() })
    const eventId = `${Date.now()}${Math.floor(Math.random() * 1000)}`
    const make = (index: number, patch: Partial<Booth> = {}): Booth => ({
      id: `${eventId}${String(index).padStart(2, '0')}`, event_id: eventId, comiket: 9999,
      circle_name: `テスト${index}`, circle_name_reading: `てすと${index}`, author_name: null,
      weekday: '土', hall: '東', island_code: 'ア', booth_number: '02', booth_suffix: 'a',
      genre: 'test', images: '[]', source_url: 'https://example.invalid/',
      last_crawled_at: '2026-01-01 00:00:00', ...patch,
    })
    const rows = [
      make(1, { booth_number: '10', booth_suffix: 'b', circle_name: 'ねこ', circle_name_reading: 'ねこ' }),
      make(2, { circle_name: 'アオ', circle_name_reading: 'あお', genre: 'Zeta' }),
      make(3, { booth_suffix: 'ab', circle_name: 'ABC', circle_name_reading: 'abc', genre: 'Alpha,Two' }),
      make(4, { booth_suffix: 'b', circle_name: 'いぬ', circle_name_reading: 'いぬ', genre: 'Zeta' }),
      make(5, { island_code: 'A', booth_number: '01', genre: null }),
      make(6, { hall: '西', island_code: 'あ', booth_number: '01' }),
      make(7, { hall: '南', island_code: 'a', booth_number: '01', genre: '' }),
      make(8, { weekday: '日', booth_number: '01', genre: 'Alpha,Two' }),
      make(9, { weekday: '月', booth_number: '01', genre: 'Zeta' }),
      make(10, { booth_number: '10', tags: '长'.repeat(800), circle_appeal: '詳細\nテスト' }),
    ]
    const query = parseBoothQuery(new URLSearchParams({ eventId }))
    const rollback = new Error('Rollback synthetic booth test records')
    await assert.rejects(connection.transaction(async transaction => {
      await transaction.insert(booths).values(rows)
      const store = new MysqlBoothRepository(async () => groups, transaction)
      const options = (await store.options(eventId))!
      assert.deepEqual(options.days.map(day => day.weekday), ['土', '日', '月'])
      assert.deepEqual(options.halls, ['東123', '東7', '西12', '南12'])
      assert.deepEqual(options.genres, ['Zeta', 'Alpha,Two', 'test', null, ''])
      const ids = (indices: number[]) => indices.map(index => rows[index - 1]!.id)
      const full = (await store.list(query))!
      assert.deepEqual(full.items.map(item => item.id), ids([2, 3, 4, 10, 1, 5, 6, 7, 8, 9]))
      assert.equal(full.total, 10)
      assert.equal(full.nextOffset, null)
      assert.equal(full.items.find(row => row.id === rows[9]!.id)!.tags!.length, 512)
      const descending = (await store.list({ ...query, direction: 'desc' }))!
      assert.deepEqual(descending.items.map(item => item.id), [...full.items].reverse().map(item => item.id))
      const byName = (await store.list({ ...query, sort: 'name' }))!
      assert.deepEqual(byName.items.slice(0, 3).map(item => item.id), ids([3, 2, 4]))
      const byGenre = (await store.list({ ...query, sort: 'genre' }))!
      assert.deepEqual(byGenre.items.map(item => item.id), ids([2, 4, 9, 3, 8, 10, 1, 6, 5, 7]))
      const genreDescending = (await store.list({ ...query, sort: 'genre', direction: 'desc' }))!
      assert.deepEqual(genreDescending.items.map(item => item.id), ids([7, 5, 10, 1, 6, 3, 8, 2, 4, 9]))
      const genrePage = (await store.list({ ...query, sort: 'genre', offset: 2, limit: 3 }))!
      assert.deepEqual(genrePage.items.map(item => item.id), ids([9, 3, 8]))
      assert.equal(genrePage.nextOffset, 5)
      const genreFiltered = (await store.list({ ...query, sort: 'genre', genres: ['Alpha,Two', null] }))!
      assert.deepEqual(genreFiltered.items.map(item => item.id), ids([3, 8, 5]))
      assert.equal(genreFiltered.total, 3)
      assert.equal((await store.list({ ...query, genres: [] }))!.total, 0)
      assert.deepEqual((await store.list({ ...query, genres: [''], halls: ['南12'] }))!.items.map(item => item.id), ids([7]))
      assert.deepEqual((await store.list({ ...query, sort: 'genre', days: ['日'], genres: ['Alpha,Two'] }))!.items.map(item => item.id), ids([8]))
      assert.deepEqual((await store.list({ ...query, sort: 'genre', days: ['日', '月'] }))!.items.map(item => item.id), ids([9, 8]))
      await assert.rejects(store.list({ ...query, genres: ['absent'] }), BoothFilterError)
      const first = (await store.list({ ...query, limit: 3 }))!
      const second = (await store.list({ ...query, limit: 3, offset: first.nextOffset! }))!
      assert.equal(first.nextOffset, 3)
      assert.deepEqual([...first.items, ...second.items].map(item => item.id), full.items.slice(0, 6).map(item => item.id))
      const filtered = (await store.list({ ...query, days: ['日'], halls: ['東123'] }))!
      assert.deepEqual(filtered.items.map(item => item.id), ids([8]))
      assert.equal(filtered.items[0]!.dayLabel, '二日目')
      assert.equal((await store.list({ ...query, days: [] }))!.total, 0)
      assert.equal((await store.list({ ...query, halls: [] }))!.total, 0)
      await assert.rejects(store.list({ ...query, halls: ['東999'] }), BoothFilterError)
      await assert.rejects(store.list({ ...query, days: ['火'] }), BoothFilterError)
      const detail = (await store.detail(rows[9]!.id))!
      assert.equal(detail.tags!.length, 800)
      assert.equal(detail.circle_appeal, '詳細\nテスト')
      throw rollback
    }), error => error === rollback)
    const [remaining] = await connection.select({ total: count() }).from(booths).where(eq(booths.event_id, eventId))
    assert.equal(remaining!.total, 0)
  })
