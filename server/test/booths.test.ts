import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { count, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { createApp } from '../src/app.js'
import { BoothFilterError, eventDays, hallGroup, parseBoothQuery, parseHallGroups } from '../src/booths/catalog.js'
import { nameReading } from '../src/booths/reading.js'
import { reconcileMapVacancies } from '../src/booths/reconcile.js'
import { MysqlBoothRepository } from '../src/booths/repository.js'
import type { BoothStore } from '../src/booths/repository.js'
import { db, pool } from '../src/db/index.js'
import { booths, mapVacancies, userFavorites, users } from '../src/db/schema.js'
import { MysqlColourStore } from '../src/colours/repository.js'
import type { Booth } from '../src/db/schema.js'
import { MemoryAuthStore } from './authFixture.js'
import { tokenHash } from '../src/auth/routes.js'

const groups = parseHallGroups({ halls: [
  { name: '東123', islands: [{ code: 'ア' }] },
  { name: '東7', islands: [{ code: 'A' }] },
  { name: '西12', islands: [{ code: 'あ' }] },
  { name: '南12', islands: [{ code: 'a' }] },
] })
const emptyMapRegions = { vacancyRegions: [], genres: [], genreRegions: [], vacancyReady: false, genreReady: false }

test('hall groups preserve Latin case and kana distinctions', () => {
  assert.equal(hallGroup(groups, '東', 'Ａ'), '東7')
  assert.equal(hallGroup(groups, '南', 'a'), '南12')
  assert.equal(hallGroup(groups, '東', 'a'), '東（未匹配）')
  assert.equal(hallGroup(groups, '西', 'ア'), '西（未匹配）')
  assert.throws(() => parseHallGroups({ halls: [{ name: '東123', islands: [{ code: 'A' }, { code: 'Ａ' }] }] }), /重复/)
  assert.throws(() => parseHallGroups({ halls: [] }), /Hall/)
})

const actualMap = new URL('../../tools/booth-recognition/output/official-map/final.json', import.meta.url)
test('hall groups use the actual locally generated map',
  { skip: !existsSync(actualMap) && 'Local OCR output is not included in Git or CI' }, async () => {
  const actual = parseHallGroups(JSON.parse(await readFile(
    actualMap, 'utf8',
  )))
  assert.equal(hallGroup(actual, '東', 'ア'), '東123')
  assert.equal(hallGroup(actual, '東', 'Ａ'), '東7')
  assert.equal(hallGroup(actual, '西', 'あ'), '西12')
  assert.equal(hallGroup(actual, '南', 'a'), '南12')
  assert.equal(hallGroup(actual, '東', 'a'), '東（未匹配）')
  assert.equal(hallGroup(actual, '南', 'A'), '南（未匹配）')
  assert.equal(hallGroup(actual, '西', 'ア'), '西（未匹配）')
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
    eventId: '240', search: '', offset: 0, limit: 40, sort: 'location', direction: 'asc', days: null, halls: null, genres: null, colours: null,
  })
  assert.deepEqual(parse('eventId=240&days=&halls=').days, [])
  assert.deepEqual(parse('eventId=240&days=土,日,土').days, ['土', '日'])
  assert.equal(parse('eventId=240&sort=genre').sort, 'genre')
  assert.equal(parse('eventId=240&sort=colour').sort, 'colour')
  assert.equal(parse('eventId=240&search=%20ABC%20').search, 'ABC')
  assert.equal(parse('eventId=240&search=%20%20').search, '')
  assert.equal(parse(`eventId=240&search=${'a'.repeat(255)}`).search.length, 255)
  assert.throws(() => parse(`eventId=240&search=${'a'.repeat(256)}`))
  assert.throws(() => parse('eventId=240&search=a&search=b'))
  const genreQuery = (values: unknown) => `eventId=240&genres=${encodeURIComponent(JSON.stringify(values))}`
  assert.deepEqual(parse(genreQuery(['Alpha,Two', null, '', 'Alpha,Two'])).genres, ['Alpha,Two', null, ''])
  assert.deepEqual(parse(genreQuery([])).genres, [])
  for (const invalid of [null, 'test', [1], ['a'.repeat(256)], Array(513).fill('test')]) {
    assert.throws(() => parse(genreQuery(invalid)))
  }
  assert.throws(() => parse('eventId=240&genres=invalid'))
  const colourQuery = (values: unknown) => `eventId=240&colours=${encodeURIComponent(JSON.stringify(values))}`
  assert.deepEqual(parse(colourQuery(['#ff0000', null, '#FF0000', '#00B54A'])).colours, ['#FF0000', null, '#00B54A'])
  assert.deepEqual(parse(colourQuery([])).colours, [])
  for (const invalid of [null, 'red', [1], ['red'], ['#123'], ['#12345678'], Array(513).fill('#FF0000')]) {
    assert.throws(() => parse(colourQuery(invalid)))
  }
  assert.throws(() => parse('eventId=240&colours=invalid'))
  assert.throws(() => parse(`${colourQuery([])}&colours=[]`))
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
  const scopes: (string | undefined)[] = []
  const optionScopes: (string | undefined)[] = []
  const mapScopes: string[] = []
  const auth = new MemoryAuthStore()
  for (const [id, token] of [['first', 'a'], ['second', 'b']] as const) {
    auth.users.set(id, { id, username: id, isAdmin: false, passwordHash: '' })
    await auth.createSession(tokenHash(token.repeat(64)), id, new Date(Date.now() + 60_000))
  }
  await auth.createSession(tokenHash('c'.repeat(64)), 'first', new Date(Date.now() - 1000))
  const store: BoothStore = {
    async options(eventId, userId) {
      optionScopes.push(userId)
      if (eventId === '999') throw new Error('test database unavailable')
      return eventId ? null : { event: null, events: [], days: [], halls: [], genres: [], colours: [], warnings: [] }
    },
    async list(query, userId) {
      scopes.push(userId)
      if (query.search) assert.equal(query.search, '社团%_')
      if (query.days?.includes('月')) throw new BoothFilterError('筛选项不属于当前活动')
      return query.eventId === '240' ? { items: [], total: 0, nextOffset: null } : null
    },
    async detail(_id, userId) { scopes.push(userId); return null },
    async days(eventId) {
      return eventId ? null : { event: null, days: [], warnings: [] }
    },
    async atLocation(query) {
      return query.eventId === '240' ? { circles: [], vacancy: null } : null
    },
    async mapData(eventId, weekday) {
      if (eventId === '999') throw new Error('test map preload unavailable')
      assert.equal(weekday, '土')
      return { merged: { 'メ': ['10', '11'] }, vacancies: { 'メ': ['12a', '12b'] }, ...emptyMapRegions }
    },
    async mapFavorites(eventId, weekday, userId) {
      mapScopes.push(userId)
      assert.equal(weekday, '土')
      if (eventId === '999') throw new Error('test favorite lookup unavailable')
      return [{ boothId: '24001', hallGroup: '東123', island: 'ア', number: '01', suffix: 'a', colour: userId === 'first' ? '#FF0000' : '#0000FF' }]
    },
  }
  const server = createApp({ checkDatabase: async () => {}, boothStore: store, mediaRoot: directory, authStore: auth }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true })
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/booths`
  const page = await fetch(`${base}?eventId=240`)
  assert.deepEqual(await page.json(), { items: [], total: 0, nextOffset: null })
  assert.equal(page.headers.get('cache-control'), 'private, no-store')
  assert.match(page.headers.get('vary') ?? '', /Cookie/)
  assert.equal((await fetch(`${base}?eventId=240&search=${encodeURIComponent('社团%_')}`)).status, 200)
  const options = await fetch(`${base}/options`)
  assert.equal(options.status, 200)
  assert.deepEqual(await options.json(), { event: null, events: [], days: [], halls: [], genres: [], colours: [], warnings: [] })
  assert.equal(options.headers.get('cache-control'), 'private, no-store')
  assert.match(options.headers.get('vary') ?? '', /Cookie/)
  for (const [path, status] of [
    ['', 400], ['?eventId=240&limit=101', 400], ['?eventId=240&days=月', 400],
    ['?eventId=241', 404], ['/options?eventId=241', 404], ['/options?eventId=999', 503],
    ['/options?eventId=240&eventId=241', 400], ['/options?foo=1', 400],
    ['/invalid', 400], ['/24001', 404], ['/images/c109/24001_0.png', 400],
    ['/images/c109/%2e%2e%2fsecret.png', 400], ['/images/c109/24001_2.png', 404],
    ['/images/c0/24001_1.png', 400],
    ['/location?eventId=240', 400],
    ['/location?eventId=240&weekday=土&hallGroup=東123&island=ア&number=01&suffix=ab', 400],
    ['/map-data', 400], ['/map-data?eventId=240&weekday=x', 400],
    ['/map-data?eventId=240&weekday=土&weekday=日', 400],
    ['/map-data?eventId=240&weekday=土&extra=1', 400],
    ['/map-data?eventId=999&weekday=土', 503],
  ] as const) {
    const response = await fetch(base + path)
    assert.equal(response.status, status, path)
    assert.match(response.headers.get('content-type') ?? '', /json/, path)
  }
  const response = await fetch(`${base}/images/c109/24001_1.png`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)
  const location = await fetch(`${base}/location?eventId=240&weekday=土&hallGroup=東123&island=ア&number=01&suffix=a`)
  assert.equal(location.status, 200)
  assert.deepEqual(await location.json(), { circles: [], vacancy: null })
  const days = await fetch(`${base}/days`)
  assert.equal(days.status, 200)
  assert.deepEqual(await days.json(), { event: null, days: [], warnings: [] })
  assert.equal((await fetch(`${base}/days?eventId=123`)).status, 404)
  assert.equal((await fetch(`${base}/days?extra=1`)).status, 400)
  const mapData = await fetch(`${base}/map-data?eventId=240&weekday=土`)
  assert.equal(mapData.status, 200)
  assert.equal(mapData.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await mapData.json(), { merged: { 'メ': ['10', '11'] }, vacancies: { 'メ': ['12a', '12b'] }, ...emptyMapRegions })
  await t.test('personal map colors require a valid session, strict event/day queries and never accept a user id', async () => {
    const url = `${base}/map-favorites?eventId=240&weekday=${encodeURIComponent('土')}`
    assert.equal((await fetch(url)).status, 401)
    for (const [token, expected] of [['a', 'first'], ['b', 'second']] as const) {
      const response = await fetch(url, { headers: { Cookie: `comike_session=${token.repeat(64)}` } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.match(response.headers.get('vary') ?? '', /Cookie/)
      assert.deepEqual(await response.json(), { favorites: [
        { boothId: '24001', hallGroup: '東123', island: 'ア', number: '01', suffix: 'a', colour: expected === 'first' ? '#FF0000' : '#0000FF' },
      ] })
      assert.equal(mapScopes.at(-1), expected)
    }
    for (const token of ['c', 'd']) {
      assert.equal((await fetch(url, { headers: { Cookie: `comike_session=${token.repeat(64)}` } })).status, 401)
    }
    for (const query of ['eventId=240', 'eventId=x&weekday=土', 'eventId=240&weekday=x',
      'eventId=240&weekday=土&weekday=日', 'eventId=240&eventId=240&weekday=土',
      'eventId=240&weekday=土&userId=second', 'eventId=240&weekday=土&internal_id=2']) {
      assert.equal((await fetch(`${base}/map-favorites?${query}`, { headers: { Cookie: `comike_session=${'a'.repeat(64)}` } })).status, 400)
    }
    assert.equal((await fetch(`${base}/map-favorites?eventId=999&weekday=土`, { headers: { Cookie: `comike_session=${'a'.repeat(64)}` } })).status, 503)
  })
  await t.test('personalization comes only from the session; expired sessions are anonymous and lookup errors fail explicitly', async () => {
    for (const [token, expected] of [['a', 'first'], ['b', 'second'], ['c', undefined], ['d', undefined]] as const) {
      const response = await fetch(`${base}?eventId=240`, { headers: { Cookie: `comike_session=${token.repeat(64)}` } })
      assert.equal(response.status, 200)
      assert.equal(scopes.at(-1), expected)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.match(response.headers.get('vary') ?? '', /Cookie/)
      assert.equal((await fetch(`${base}/options`, { headers: { Cookie: `comike_session=${token.repeat(64)}` } })).status, 200)
      assert.equal(optionScopes.at(-1), expected)
      const detail = await fetch(`${base}/24001`, { headers: { Cookie: `comike_session=${token.repeat(64)}` } })
      assert.equal(detail.status, 404)
      assert.equal(scopes.at(-1), expected)
      assert.equal(detail.headers.get('cache-control'), 'private, no-store')
      assert.match(detail.headers.get('vary') ?? '', /Cookie/)
    }
    for (const parameter of ['userId=second', 'user_id=2', 'internal_id=2']) {
      assert.equal((await fetch(`${base}?eventId=240&${parameter}`, {
        headers: { Cookie: `comike_session=${'a'.repeat(64)}` },
      })).status, 400)
      assert.equal((await fetch(`${base}/options?${parameter}`)).status, 400)
    }
    const calls = scopes.length
    t.mock.method(auth, 'sessionUser', async () => { throw new Error('test auth database unavailable') })
    assert.equal((await fetch(`${base}?eventId=240`, { headers: { Cookie: `comike_session=${'a'.repeat(64)}` } })).status, 503)
    assert.equal(scopes.length, calls)
    assert.equal((await fetch(`${base}?eventId=240`)).status, 200)
    assert.equal(scopes.at(-1), undefined)
    assert.equal((await fetch(`${base}/options`, { headers: { Cookie: `comike_session=${'a'.repeat(64)}` } })).status, 503)
    assert.equal((await fetch(`${base}/24001`, { headers: { Cookie: `comike_session=${'a'.repeat(64)}` } })).status, 503)
    assert.equal((await fetch(`${base}/days`, { headers: { Cookie: `comike_session=${'a'.repeat(64)}` } })).status, 200)
    assert.equal((await fetch(`${base}/map-favorites?eventId=240&weekday=土`, { headers: { Cookie: `comike_session=${'a'.repeat(64)}` } })).status, 503)
  })
})

test('MySQL sorts, filters and paginates actual booth rows without changing existing data',
  { skip: !db && 'Run with the server .env loaded for the MySQL integration check' }, async t => {
    const queries: string[] = []
    const connection = drizzle({ client: pool!, logger: { logQuery(query) { queries.push(query) } } })
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
      make(6, { hall: '西', island_code: 'あ', booth_number: '01', author_name: '作者%_\\テスト' }),
      make(7, { hall: '南', island_code: 'a', booth_number: '01', genre: '' }),
      make(8, { weekday: '日', booth_number: '01', genre: 'Alpha,Two' }),
      make(9, { weekday: '月', booth_number: '01', genre: 'Zeta' }),
      make(10, { booth_number: '10', tags: `${'长'.repeat(797)}末尾标`, circle_appeal: '詳細\nテスト' }),
    ]
    const query = parseBoothQuery(new URLSearchParams({ eventId }))
    const directory = await mkdtemp(join(tmpdir(), 'comike-map-reconcile-sql-'))
    t.after(() => rm(directory, { recursive: true }))
    const mapFile = join(directory, 'map.json')
    await writeFile(mapFile, JSON.stringify({ halls: [{ name: '東123', islands: [{ code: 'ア', blocks: [{ booths: [
      { id: 'm1', number: '02', bbox: { x: 0, y: 0, width: 20, height: 20 }, split: { a: 'l', b: 'r' } },
      { id: 'm2', number: '99', bbox: { x: 20, y: 0, width: 20, height: 20 }, split: { a: 't', b: 'b' } },
    ] }] }] }] }))
    const rollback = new Error('Rollback synthetic booth test records')
    await assert.rejects(connection.transaction(async transaction => {
      await transaction.insert(booths).values(rows)
      const store = new MysqlBoothRepository(async () => groups, transaction)
      const options = (await store.options(eventId))!
      assert.deepEqual(options.days.map(day => day.weekday), ['土', '日', '月'])
      assert.deepEqual(options.halls, ['東123', '東7', '西12', '南12'])
      assert.deepEqual(options.genres, ['Zeta', 'Alpha,Two', 'test', null, ''])
      t.mock.method(store, 'options', async () => { throw new Error('Non-options paths must not recompute full filter options') })
      const ids = (indices: number[]) => indices.map(index => rows[index - 1]!.id)
      queries.length = 0
      const full = (await store.list(query))!
      assert.equal(queries.length, 3)
      assert.ok(queries.every(query => !/row_number/i.test(query)))
      queries.length = 0
      assert.equal((await store.list({ ...query, sort: 'genre', genres: [] }))!.total, 0)
      assert.equal(queries.length, 1)
      assert.ok(queries.every(query => !/row_number/i.test(query)))
      assert.deepEqual(full.items.map(item => item.id), ids([2, 3, 4, 10, 1, 5, 6, 7, 8, 9]))
      assert.equal(full.total, 10)
      assert.equal(full.nextOffset, null)
      assert.ok(full.items.every(row => row.colour === null && row.memo === null))
      assert.equal(full.items.find(row => row.id === rows[9]!.id)!.tags!.length, 512)
      for (const [search, expected] of [
        ['ねこ', [1]], ['作者', [6]], ['Zeta', [2, 4, 9]], ['末尾标', [10]],
        ['%_', [6]], ['\\', [6]], ['ABC', [3]], ['absent-search', []],
        ["' OR 1=1 --", []], ['詳細', []],
      ] as const) {
        const result = (await store.list({ ...query, search }))!
        assert.deepEqual(result.items.map(item => item.id), ids([...expected]), search)
        assert.equal(result.total, expected.length, search)
      }
      await t.test('own favourite colours and full memos are joined without exposing another user or changing pagination', async () => {
        const [firstId, secondId] = [randomUUID(), randomUUID()]
        await transaction.insert(users).values([
          { id: firstId, username: `list_${eventId}_a`, password_hash: 'test-only', created_at: new Date() },
          { id: secondId, username: `list_${eventId}_b`, password_hash: 'test-only', created_at: new Date() },
        ])
        const [first] = await transaction.select().from(users).where(eq(users.id, firstId))
        const [second] = await transaction.select().from(users).where(eq(users.id, secondId))
        const memo = 'private-first %_\\\n中文 <script>literal</script>'
        await transaction.insert(userFavorites).values([
          { user_id: first!.internal_id, booth_id: rows[1]!.id, colour: '#FFF700', memo },
          { user_id: first!.internal_id, booth_id: rows[3]!.id, colour: '#FF0000', memo: 'private-first Zeta' },
          { user_id: first!.internal_id, booth_id: rows[4]!.id, colour: '#00B54A', memo: '' },
          { user_id: first!.internal_id, booth_id: rows[9]!.id, colour: '#FF0000', memo: '' },
          { user_id: first!.internal_id, booth_id: `${eventId}99`, colour: '#ABCDEF', memo: '' },
          { user_id: second!.internal_id, booth_id: rows[1]!.id, colour: '#0000FF', memo: 'private-second' },
          { user_id: second!.internal_id, booth_id: rows[2]!.id, colour: '#FF00FF', memo: 'private-second' },
        ])
        const personal = (await store.list(query, firstId))!
        assert.deepEqual(personal.items.map(row => row.id), full.items.map(row => row.id))
        assert.equal(personal.total, full.total)
        const own = personal.items.find(row => row.id === rows[1]!.id)!
        assert.equal(own.colour, '#FFF700')
        assert.equal(own.memo, memo)
        assert.equal(personal.items.find(row => row.id === rows[2]!.id)!.colour, null)
        assert.equal(personal.items.find(row => row.id === rows[2]!.id)!.memo, null)
        assert.equal(personal.items.find(row => row.id === rows[4]!.id)!.memo, '')
        assert.equal('user_id' in own, false)
        assert.equal('internal_id' in own, false)
        const other = (await store.list(query, secondId))!
        assert.equal(other.items.find(row => row.id === rows[1]!.id)!.colour, '#0000FF')
        assert.equal(other.items.find(row => row.id === rows[1]!.id)!.memo, 'private-second')
        assert.equal((await store.detail(rows[1]!.id, firstId))!.memo, memo)
        assert.equal((await store.detail(rows[1]!.id, firstId))!.colour, '#FFF700')
        assert.equal((await store.detail(rows[1]!.id, secondId))!.colour, '#0000FF')
        assert.equal((await store.detail(rows[2]!.id, firstId))!.colour, null)
        assert.equal((await store.detail(rows[1]!.id, secondId))!.memo, 'private-second')
        assert.equal((await store.detail(rows[2]!.id, firstId))!.memo, null)
        assert.equal((await store.detail(rows[4]!.id, firstId))!.memo, '')
        for (const userId of [undefined, randomUUID()]) {
          assert.equal((await store.detail(rows[1]!.id, userId))!.memo, null)
          assert.equal((await store.detail(rows[1]!.id, userId))!.colour, null)
          assert.ok((await store.list(query, userId))!.items.every(row => row.colour === null && row.memo === null))
          assert.equal((await store.list({ ...query, search: 'private-first' }, userId))!.total, 0)
        }
        assert.equal((await store.list({ ...query, search: 'private-first' }, secondId))!.total, 0)
        assert.equal((await store.list({ ...query, search: 'private-second' }, firstId))!.total, 0)
        for (const [search, expected] of [['%_\\', [2, 6]], ['中文', [2]], ['<script>literal</script>', [2]]] as const) {
          const result = (await store.list({ ...query, search }, firstId))!
          assert.equal(result.total, expected.length)
          assert.deepEqual(result.items.map(row => row.id), ids([...expected]))
        }
        const search = { ...query, search: 'private-first', limit: 1 }
        const page1 = (await store.list(search, firstId))!
        const page2 = (await store.list({ ...search, offset: page1.nextOffset! }, firstId))!
        assert.equal(page1.total, 2)
        assert.equal(page2.total, 2)
        assert.equal(page1.nextOffset, 1)
        assert.equal(page2.nextOffset, null)
        assert.deepEqual([...page1.items, ...page2.items].map(row => row.id), ids([2, 4]))
        for (const sort of ['name', 'location', 'genre'] as const) {
          const result = (await store.list({ ...query, search: 'private-first', sort, genres: ['Zeta'], halls: ['東123'], days: ['土'] }, firstId))!
          assert.equal(result.total, 2)
          assert.deepEqual(new Set(result.items.map(row => row.id)), new Set(ids([2, 4])))
        }
        const overlap = (await store.list({ ...query, search: 'Zeta' }, firstId))!
        assert.equal(overlap.total, 3)
        assert.deepEqual(overlap.items.map(row => row.id), ids([2, 4, 9]))
        assert.equal((await store.list({ ...query, days: [] }, firstId))!.total, 0)
        const optionStore = new MysqlBoothRepository(async () => groups, transaction)
        const located = await store.mapFavorites(eventId, '土', firstId)
        assert.deepEqual(located, [
          { boothId: rows[1]!.id, hallGroup: '東123', island: 'ア', number: '02', suffix: 'a', colour: '#FFF700' },
          { boothId: rows[3]!.id, hallGroup: '東123', island: 'ア', number: '02', suffix: 'b', colour: '#FF0000' },
          { boothId: rows[4]!.id, hallGroup: '東7', island: 'A', number: '01', suffix: 'a', colour: '#00B54A' },
          { boothId: rows[9]!.id, hallGroup: '東123', island: 'ア', number: '10', suffix: 'a', colour: '#FF0000' },
        ])
        assert.deepEqual(await store.mapFavorites(eventId, '土', secondId), [
          { boothId: rows[1]!.id, hallGroup: '東123', island: 'ア', number: '02', suffix: 'a', colour: '#0000FF' },
          { boothId: rows[2]!.id, hallGroup: '東123', island: 'ア', number: '02', suffix: 'ab', colour: '#FF00FF' },
        ])
        assert.deepEqual(await store.mapFavorites(eventId, '日', firstId), [])
        assert.deepEqual(await store.mapFavorites(`${eventId}0`, '土', firstId), [])
        assert.deepEqual(await store.mapFavorites(eventId, '土', randomUUID()), [])
        assert.deepEqual((await optionStore.options(eventId, firstId))!.colours, ['#00B54A', '#FF0000', '#FFF700'])
        assert.deepEqual((await optionStore.options(eventId, secondId))!.colours, ['#0000FF', '#FF00FF'])
        queries.length = 0
        assert.deepEqual((await optionStore.options(eventId))!.colours, [])
        assert.ok(queries.every(query => !/user_favorites/.test(query)))
        const colourCases: [(string | null)[] | null, number[]][] = [
          [['#00B54A', '#FF0000', '#FFF700'], [2, 4, 10, 5]],
          [['#FF0000'], [4, 10]],
          [[null], [3, 1, 6, 7, 8, 9]],
          [['#FFF700', null], [2, 3, 1, 6, 7, 8, 9]],
          [[], []],
          [['#0000FF'], []],
          [null, [2, 3, 4, 10, 1, 5, 6, 7, 8, 9]],
        ]
        for (const [colours, expected] of colourCases) {
          const result = (await store.list({ ...query, colours }, firstId))!
          assert.equal(result.total, expected.length)
          assert.deepEqual(result.items.map(row => row.id), ids(expected))
        }
        assert.equal((await store.list({ ...query, colours: ['#FF0000'] }, secondId))!.total, 0)
        assert.equal((await store.list({ ...query, colours: ['#FF0000'] }))!.total, 0)
        assert.equal((await store.list({ ...query, colours: [null] }))!.total, full.total)
        const combined = (await store.list({
          ...query, colours: ['#FF0000'], search: 'private-first', days: ['土'], halls: ['東123'], genres: ['Zeta'],
        }, firstId))!
        assert.equal(combined.total, 1)
        assert.deepEqual(combined.items.map(row => row.id), ids([4]))
        for (const [direction, expected] of [
          ['asc', [5, 4, 10, 2, 3, 1, 6, 7, 8, 9]],
          ['desc', [2, 4, 10, 5, 3, 1, 6, 7, 8, 9]],
        ] as const) {
          const sortedQuery = { ...query, sort: 'colour' as const, direction }
          const sorted = (await store.list(sortedQuery, firstId))!
          assert.deepEqual(sorted.items.map(row => row.id), ids([...expected]))
          const paged: string[] = []
          let offset: number | null = 0
          while (offset !== null) {
            const page = (await store.list({ ...sortedQuery, offset, limit: 3 }, firstId))!
            assert.equal(page.total, full.total)
            paged.push(...page.items.map(row => row.id))
            offset = page.nextOffset
          }
          assert.deepEqual(paged, ids([...expected]))
        }
        assert.deepEqual((await store.list({ ...query, sort: 'colour' }))!.items.map(row => row.id), full.items.map(row => row.id))
        const priorities = new MysqlColourStore(transaction)
        assert.deepEqual((await priorities.list(firstId)).map(entry => entry.colour), ['#00B54A', '#ABCDEF', '#FF0000', '#FFF700'])
        await priorities.reorder(firstId, ['#FFF700', '#FF0000', '#ABCDEF', '#00B54A'])
        assert.deepEqual((await optionStore.options(eventId, firstId))!.colours, ['#FFF700', '#FF0000', '#00B54A'])
        assert.deepEqual((await optionStore.options(eventId, secondId))!.colours, ['#0000FF', '#FF00FF'])
        for (const [direction, expected] of [
          ['asc', [2, 4, 10, 5, 3, 1, 6, 7, 8, 9]],
          ['desc', [5, 4, 10, 2, 3, 1, 6, 7, 8, 9]],
        ] as const) {
          const paged: string[] = []
          let offset: number | null = 0
          while (offset !== null) {
            const page = (await store.list({ ...query, sort: 'colour', direction, offset, limit: 3 }, firstId))!
            assert.equal(page.total, full.total)
            paged.push(...page.items.map(row => row.id))
            offset = page.nextOffset
          }
          assert.deepEqual(paged, ids([...expected]))
        }
        assert.deepEqual((await store.list({
          ...query, sort: 'colour', colours: ['#FF0000', '#FFF700'], search: 'private-first',
        }, firstId))!.items.map(row => row.id), ids([2, 4]))
      })
      const searchedPage = (await store.list({ ...query, search: 'Zeta', limit: 1 }))!
      assert.equal(searchedPage.total, 3)
      assert.equal(searchedPage.nextOffset, 1)
      assert.deepEqual((await store.list({ ...query, search: 'Zeta', offset: 1, limit: 1 }))!.items.map(item => item.id), ids([4]))
      assert.deepEqual((await store.list({ ...query, search: 'Zeta', days: ['月'], genres: ['Zeta'], sort: 'genre' }))!.items.map(item => item.id), ids([9]))
      assert.equal((await store.list({ ...query, search: '作者', halls: ['東123'] }))!.total, 0)
      assert.equal((await store.list({ ...query, eventId: `${eventId}0`, search: '作者' })), null)
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
      queries.length = 0
      const detail = (await store.detail(rows[9]!.id))!
      assert.equal(queries.length, 2)
      assert.ok(queries.every(query => !/row_number|group by|order by/i.test(query)))
      assert.equal(detail.tags!.length, 800)
      assert.equal(detail.circle_appeal, '詳細\nテスト')
      const location = { eventId, weekday: '土', hallGroup: '東123', island: 'ア', number: '02', suffix: 'a' as const }
      queries.length = 0
      assert.deepEqual((await store.atLocation(location))!.circles.map(row => row.id), ids([2, 3]))
      assert.equal(queries.length, 3)
      assert.ok(queries.every(query => !/row_number|group by/i.test(query)))
      assert.deepEqual((await store.atLocation({ ...location, suffix: 'b' }))!.circles.map(row => row.id), ids([3, 4]))
      await assert.rejects(store.atLocation({ ...location, hallGroup: '東7' }), BoothFilterError)
      const empty = { ...location, number: '99' }
      await transaction.insert(mapVacancies).values({
        event_id: eventId, comiket: 9999, weekday: '土', hall: '東',
        hall_group: '東123', island_code: 'ア', booth_number: '99', booth_suffix: 'a',
        map_booth_id: 'test-map-cell', checked_at: '2026-01-01 00:00:00',
      })
      assert.equal((await store.atLocation(empty))!.vacancy!.map_booth_id, 'test-map-cell')
      assert.equal((await store.atLocation({ ...empty, suffix: 'b' }))!.vacancy, null)
      queries.length = 0
      assert.deepEqual(await store.mapData(eventId, '土'), {
        merged: { 'ア': ['02'] }, vacancies: { 'ア': ['99a'] },
        ...emptyMapRegions,
      })
      assert.equal(queries.length, 5)
      assert.ok(queries.every(query => !/row_number|group by/i.test(query)))
      assert.deepEqual(await store.mapData(eventId, '日'), { merged: {}, vacancies: {}, ...emptyMapRegions })
      assert.deepEqual(await store.mapData(`${eventId}0`, '土'), { merged: {}, vacancies: {}, ...emptyMapRegions })
      const reconciliation = await reconcileMapVacancies(mapFile, eventId, transaction)
      assert.equal(reconciliation.vacancies, 10)
      const savedVacancies = await transaction.select().from(mapVacancies).where(eq(mapVacancies.event_id, eventId))
      assert.equal(savedVacancies.length, 10)
      const positions = (rows: typeof savedVacancies) => rows.map(({ checked_at: _checkedAt, ...position }) => JSON.stringify(position)).sort()
      const firstPositions = positions(savedVacancies)
      assert.ok(savedVacancies.every(row => !('id' in row)))
      assert.equal((await reconcileMapVacancies(mapFile, eventId, transaction)).vacancies, 10)
      assert.deepEqual(positions(await transaction.select().from(mapVacancies).where(eq(mapVacancies.event_id, eventId))), firstPositions)
      await transaction.insert(booths).values(make(11, { booth_number: '99', booth_suffix: 'ab' }))
      assert.equal((await reconcileMapVacancies(mapFile, eventId, transaction)).vacancies, 8)
      assert.equal((await store.atLocation(empty))!.circles[0]!.booth_suffix, 'ab')
      assert.equal((await store.atLocation(empty))!.vacancy, null)
      assert.deepEqual((await store.mapData(eventId, '土')).merged, { 'ア': ['02', '99'] })
      assert.deepEqual((await store.mapData(eventId, '土')).vacancyRegions, [{ hallGroup: '東123', rectangles: [] }])
      await writeFile(mapFile, '{"halls":[]}')
      await assert.rejects(reconcileMapVacancies(mapFile, eventId, transaction), /Hall/)
      assert.equal((await transaction.select().from(mapVacancies).where(eq(mapVacancies.event_id, eventId))).length, 8)
      await transaction.insert(booths).values([
        make(12, { island_code: 'A', booth_number: '01', booth_suffix: 'ab' }),
        make(13, { island_code: 'a', booth_number: '02', booth_suffix: 'ab' }),
        make(14, { island_code: 'ｱ', booth_number: '02', booth_suffix: 'ab' }),
      ])
      assert.deepEqual((await store.mapData(eventId, '土')).merged, {
        'ア': ['02', '99'], A: ['01'], a: ['02'],
      })
      throw rollback
    }), error => error === rollback)
    const [remaining] = await connection.select({ total: count() }).from(booths).where(eq(booths.event_id, eventId))
    assert.equal(remaining!.total, 0)
  })
