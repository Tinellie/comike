import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { getGlobalDispatcher, MockAgent, ProxyAgent, setGlobalDispatcher } from 'undici'
import { createApp } from '../src/app.js'
import { tokenHash } from '../src/auth/routes.js'
import { MemoryAuthStore } from './authFixture.js'
import { normalizeTwitterApiKey, RettiwtSource, TwitterAccessError } from '../src/social/twitter/source.js'
import type { TwitterClient, TwitterImage, TwitterSource } from '../src/social/twitter/source.js'
import { TwitterService } from '../src/social/twitter/service.js'
import { MysqlTwitterStore } from '../src/social/twitter/repository.js'
import type { TwitterBooth, TwitterStore } from '../src/social/twitter/repository.js'
import { PixivStorage } from '../src/social/pixiv/storage.js'
import { db, pool } from '../src/db/index.js'
import { booths, imagesTwitter, users, userFavorites } from '../src/db/schema.js'
import { MysqlJobRepository } from '../src/crawler/repository.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const twitterImage = (id: string, mediaIndex = 0): TwitterImage => ({
  id, url: `https://pbs.twimg.com/media/${id}.jpg?name=thumb`,
  tweetId: '100', publishedAt: new Date('2026-11-18T00:00:00Z'), mediaIndex,
})
class MemoryStore implements TwitterStore {
  row: TwitterBooth = { id: '1', username: 'artist', numberId: null, updatedAt: null }
  records: string[] = []
  scopes: { userId: string; missingOnly: boolean }[] = []
  async booth(id: string) { return id === '1' ? { ...this.row } : null }
  async favorites(userId: string, missingOnly: boolean) {
    this.scopes.push({ userId, missingOnly })
    return missingOnly && this.row.updatedAt ? [] : ['1']
  }
  async resolve(_username: string, id: string) { this.row.numberId = id }
  async images() { return [...this.records] }
  async replace(_id: string, images: TwitterImage[]) { this.records = images.map(image => image.id) }
  async complete(_id: string, images: TwitterImage[], date: Date) { this.records = images.map(image => image.id); this.row.updatedAt = date }
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'comike-twitter-'))
  const storage = new PixivStorage(root, 'twitter'), store = new MemoryStore()
  const calls: string[] = []
  const source: TwitterSource = {
    async resolve(username) { calls.push(`resolve:${username}`); return '11' },
    async latest(id) { calls.push(`media:${id}`); return ['11', '13', '12'].map(twitterImage) },
    async download(url) { calls.push(url); return { body: png, extension: 'png' } },
  }
  let time = new Date('2026-11-18T00:00:00Z')
  const service = new TwitterService(store, source, storage, () => time)
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  return { root, storage, store, source, service, calls, setTime: (date: Date) => { time = date } }
}
async function finished(service: TwitterService) {
  for (let i = 0; i < 100; i++) {
    const state = service.status('owner')
    if (state.status !== 'running') return state
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Twitter job did not finish')
}

test('Rettiwt resolves permanent IDs, paginates media and downloads only thumb photos/video covers', async () => {
  const cursors: (string | undefined)[] = []
  const tweet = (id: string, owner = '11') => ({
    id, createdAt: new Date(Date.UTC(2026, 10, 1, 0, Number(id))).toISOString(),
    tweetBy: { id: owner },
    raw: { legacy: { extended_entities: { media: [{ id_str: id, media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/${id}.jpg` }] } } },
  })
  const client: TwitterClient = {
    async details(name) { assert.equal(name, 'artist'); return { id: '11' } },
    async media(id, count, cursor) {
      assert.equal(id, '11'); assert.equal(count, 20); cursors.push(cursor)
      return cursor ? { list: Array.from({ length: 10 }, (_, i) => tweet(String(20 - i))), next: '' }
        : { list: [
          { ...tweet('1'), raw: { legacy: {} } },
          { ...tweet('2'), raw: { legacy: { extended_entities: { media: [] } } } },
          tweet('22'), tweet('99', '22'),
        ], next: 'page2' }
    },
  }
  const source = new RettiwtSource({}, client, async (input, options) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'pbs.twimg.com')
    assert.ok(url.pathname.endsWith('.jpg:thumb'))
    assert.equal(url.searchParams.has('name'), false)
    assert.equal(url.searchParams.has('format'), false)
    assert.equal(new Headers(options?.headers).get('authorization'), null)
    return new Response(png)
  })
  const signal = new AbortController().signal
  assert.equal(await source.resolve('artist', signal), '11')
  const images = await source.latest('11', signal)
  assert.deepEqual(images.map(image => image.id), ['22', '20', '19', '18', '17', '16', '15', '14', '13', '12'])
  assert.deepEqual(cursors, [undefined, 'page2'])
  assert.deepEqual(await source.download(images[0]!.url, signal), { body: png, extension: 'png' })
  await assert.rejects(source.download('https://pbs.twimg.com.evil.invalid/a.jpg', signal), /URL/)
  await assert.rejects(new RettiwtSource().latest('11', signal), /TWITTER_API_KEY/)
  client.media = async () => ({ list: [{ ...tweet('1'), raw: {} }], next: '' })
  await assert.rejects(source.latest('11', signal), /媒体条目格式无效/)
  client.media = async () => ({ list: [{ ...tweet('1'), createdAt: 'invalid' }], next: '' })
  await assert.rejects(source.latest('11', signal), /发布时间或 ID 无效/)
  client.media = async () => ({ list: [], next: 'repeated' })
  await assert.rejects(source.latest('11', signal), /分页无进展/)
  client.media = async () => { throw { status: 429, config: { secret: 'must-not-log' } } }
  await assert.rejects(source.latest('11', signal), error => error instanceof TwitterAccessError && error.message.includes('429'))
})

test('latest media use publication time and attachment order, confirm pagination and ignore old pinned media IDs', async () => {
  const tweet = (id: string, createdAt: string, ids: string[]) => ({
    id, createdAt, tweetBy: { id: '11' },
    raw: { legacy: { extended_entities: { media: ids.map(id_str => ({
      id_str, media_url_https: `https://pbs.twimg.com/media/${id_str}.jpg`,
    })) } } },
  })
  const calls: (string | undefined)[] = []
  const client: TwitterClient = {
    async details() { return { id: '11' } },
    async media(_id, _count, cursor) {
      calls.push(cursor)
      if (!cursor) return { list: [
        tweet('10', '2020-01-01T00:00:00Z', ['1', ...Array.from({ length: 12 }, (_, i) => String(9900 + i))]),
        tweet('300', '2026-11-18T00:00:00Z', ['1', '900']),
      ], next: 'newer-than-pin' }
      if (cursor === 'newer-than-pin') return {
        list: [tweet('200', '2026-11-17T00:00:00Z', ['10', '30', '20', '40', '50', '60', '70', '80', '90', '100'])], next: 'older',
      }
      assert.equal(cursor, 'older')
      return { list: [tweet('100', '2026-11-16T00:00:00Z', ['99999'])], next: 'unneeded' }
    },
  }
  const images = await new RettiwtSource({}, client).latest('11', new AbortController().signal)
  assert.deepEqual(images.map(image => image.id), ['1', '900', '10', '30', '20', '40', '50', '60', '70', '80'])
  assert.equal(images[0]!.tweetId, '300')
  assert.equal(images[0]!.publishedAt.toISOString(), '2026-11-18T00:00:00.000Z')
  assert.deepEqual(images.slice(2).map(image => image.mediaIndex), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(calls, [undefined, 'newer-than-pin', 'older'])
})

test('photo and video cover URLs keep thumb size without requesting originals or retrying real 404s', async () => {
  const requests: string[] = []
  const source = new RettiwtSource({}, undefined, async input => {
    requests.push(String(input))
    return requests.length <= 5 ? new Response(png) : new Response(null, { status: 404 })
  })
  const signal = new AbortController().signal
  for (const bucket of ['amplify_video_thumb', 'ext_tw_video_thumb', 'tweet_video_thumb']) {
    await source.download(`https://pbs.twimg.com/${bucket}/11/img/cover.jpg?format=jpg&name=orig`, signal)
    assert.equal(requests.at(-1), `https://pbs.twimg.com/${bucket}/11/img/cover.jpg:thumb`)
  }
  await source.download('https://pbs.twimg.com/amplify_video_thumb/11/img/cover.jpg:thumb', signal)
  assert.equal(requests.at(-1), 'https://pbs.twimg.com/amplify_video_thumb/11/img/cover.jpg:thumb')
  await source.download('https://pbs.twimg.com/media/photo.jpg?name=orig', signal)
  const photo = new URL(requests.at(-1)!)
  assert.equal(photo.pathname, '/media/photo')
  assert.equal(photo.searchParams.get('format'), 'jpg')
  assert.equal(photo.searchParams.get('name'), 'thumb')
  await assert.rejects(source.download('https://pbs.twimg.com/media/missing.jpg', signal), /HTTP 404/)
  assert.equal(requests.length, 6)
})

test('browser Cookie keys accept separator whitespace without changing credential values', () => {
  const canonical = 'other=a=b%3D;auth_token=abc123;ct0=def456;twid=u%3D11;'
  for (const cookie of [
    'other=a=b%3D; auth_token=abc123; ct0=def456; twid=u%3D11',
    '  other=a=b%3D; \tauth_token=abc123;  ct0=def456; twid=u%3D11;  ; ',
    canonical,
  ]) {
    const key = normalizeTwitterApiKey(Buffer.from(cookie, 'ascii').toString('base64'))
    assert.equal(Buffer.from(key, 'base64').toString('ascii'), canonical)
  }
})

test('Twitter API errors preserve safe network/status diagnostics without exposing credentials', async () => {
  const cases = [
    { error: { code: 'ECONNRESET', config: { secret: 'must-not-log' } }, match: /ECONNRESET.*TWITTER_PROXY_URL/ },
    { error: { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, match: /UND_ERR_CONNECT_TIMEOUT.*TWITTER_PROXY_URL/ },
    { error: { response: { status: 403, data: 'must-not-log' } }, match: /HTTP 403/ },
    { error: { response: { status: 401, data: 'must-not-log' } }, match: /HTTP 401.*TWITTER_API_KEY/ },
    { error: { response: { status: 502 } }, match: /HTTP 502/ },
    { error: { code: 'KEY_BYTE_INDICES_EXTRACTION_ERROR', message: 'must-not-log' }, match: /请求标识初始化失败/ },
    { error: new Error('must-not-log'), match: /Twitter API 请求失败/ },
  ]
  for (const { error, match } of cases) {
    const source = new RettiwtSource({}, {
      async details() { throw error },
      async media() { throw error },
    })
    await assert.rejects(source.resolve('artist', new AbortController().signal), reason => {
      assert.ok(reason instanceof Error)
      assert.match(reason.message, match)
      assert.ok(!reason.stack?.includes('must-not-log'))
      assert.equal(reason.cause, undefined)
      return true
    })
  }
})

test('Rettiwt internal native fetch uses only its own request-scoped proxy', async t => {
  const previous = getGlobalDispatcher()
  const direct = new MockAgent(), proxied = new MockAgent()
  direct.disableNetConnect(); proxied.disableNetConnect()
  direct.get('https://abs.twimg.com').intercept({ path: '/probe' }).reply(200, '22')
  proxied.get('https://abs.twimg.com').intercept({ path: '/probe' }).reply(200, '11')
  setGlobalDispatcher(direct)
  t.mock.method(ProxyAgent.prototype, 'dispatch', (options, handler) => proxied.dispatch(options, handler))
  const source = new RettiwtSource({ proxyUrl: 'http://127.0.0.1:9999' }, {
    async details() { return { id: await (await fetch('https://abs.twimg.com/probe')).text() } },
    async media() { return { list: [], next: '' } },
  })
  try {
    const [id, unrelated] = await Promise.all([
      source.resolve('artist', new AbortController().signal),
      fetch('https://abs.twimg.com/probe').then(response => response.text()),
    ])
    assert.equal(id, '11')
    assert.equal(unrelated, '22')
    direct.assertNoPendingInterceptors(); proxied.assertNoPendingInterceptors()
  } finally {
    await source.close()
    setGlobalDispatcher(previous)
    await Promise.all([direct.close(), proxied.close()])
  }
})

test('Twitter cached galleries stay local-only, batches persist thumbnails, resolve once and preserve cache on failures', async t => {
  const { root, storage, store, source, service, calls, setTime } = await fixture(t)
  assert.deepEqual(await service.gallery('1'), { images: [], missingCount: 0 })
  assert.deepEqual(calls, [])
  assert.equal(await service.checkBooth('1'), 'updated')
  assert.deepEqual((await service.gallery('1'))!.images.map(image => image.id), ['11', '13', '12'])
  assert.deepEqual(await readdir(root), ['twitter'])
  assert.equal(store.row.numberId, '11')
  assert.equal(await service.checkBooth('1'), 'skipped')
  assert.equal(calls.filter(call => call.startsWith('resolve:')).length, 1)
  setTime(new Date('2026-11-18T01:00:00Z'))
  const originalTime = store.row.updatedAt
  source.latest = async () => [twitterImage('14')]
  source.download = async () => { throw new Error('Download failed') }
  await assert.rejects(service.checkBooth('1'), /Download failed/)
  assert.equal(store.row.updatedAt, originalTime)
  assert.deepEqual(store.records, ['11', '13', '12'])
  assert.equal((await storage.list('11')).length, 3)
})

test('Twitter live galleries reuse cached files, bypass batch TTL and forward new images while saving in the background', async t => {
  const { service, store, source, storage, calls } = await fixture(t)
  await service.checkBooth('1')
  const timestamp = store.row.updatedAt
  source.latest = async () => { calls.push('live'); return [twitterImage('14'), twitterImage('11')] }
  const stage = storage.stage.bind(storage)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(storage, 'stage', async (...args: Parameters<PixivStorage['stage']>) => {
    await gate
    return stage(...args)
  })
  const signal = new AbortController().signal
  const result = await service.liveGallery('1', signal)
  assert.equal(result!.missingCount, 1)
  assert.equal(result!.images[1]!.url, '/api/social/twitter/images/11/11.png')
  assert.deepEqual(store.records, ['14', '11'])
  const token = result!.images[0]!.url.split('/').at(-1)!
  try {
    const images = await Promise.all([service.liveImage(token), service.liveImage(token)])
    assert.ok(images.every(image => image.body.equals(png)))
    assert.equal(calls.filter(call => call.includes('/14.jpg')).length, 1)
    assert.deepEqual((await service.gallery('1'))!.images.map(image => image.id), ['11'])
    await assert.rejects(service.liveImage(`${token}bad`), /图片链接无效/)
  } finally { release() }
  await service.liveGallery('1', signal)
  assert.equal(calls.filter(call => call === 'live').length, 2)
  assert.equal(store.row.updatedAt, timestamp, 'Detail sync must not mark a whole batch crawl completed')
  await service.close()
  assert.deepEqual((await service.gallery('1'))!.images.map(image => image.id), ['14', '11'])
  assert.equal((await storage.list('11')).length, 4)
})

test('Twitter live galleries resolve IDs without downloading thumbnails, preserve cache on failures and persist empty latest lists', async t => {
  const { service, store, source, calls } = await fixture(t)
  await service.liveGallery('1', new AbortController().signal)
  assert.equal(store.row.numberId, '11')
  assert.deepEqual(calls, ['resolve:artist', 'media:11'])
  source.latest = async () => { throw new Error('List unavailable') }
  await assert.rejects(service.liveGallery('1', new AbortController().signal), /List unavailable/)
  assert.deepEqual(store.records, ['11', '13', '12'])
  source.latest = async () => []
  assert.deepEqual(await service.liveGallery('1', new AbortController().signal), { images: [], missingCount: 0 })
  assert.deepEqual(store.records, [])
})

test('Twitter routes enforce session ownership, protect live requests and serve cached galleries publicly', async t => {
  const { service, source, store, calls } = await fixture(t)
  const auth = new MemoryAuthStore()
  auth.users.set('owner', { id: 'owner', username: 'owner', isAdmin: false, passwordHash: '' })
  await auth.createSession(tokenHash('a'.repeat(64)), 'owner', new Date(Date.now() + 60_000))
  const server = createApp({ checkDatabase: async () => {}, authStore: auth, twitter: service }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/social/twitter`
  const headers = { Cookie: `comike_session=${'a'.repeat(64)}`, 'Content-Type': 'application/json' }
  assert.equal((await fetch(`${base}/status`)).status, 401)
  assert.equal((await fetch(`${base}/start`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/live/booths/1`)).status, 401)
  assert.equal((await fetch(`${base}/live/images/invalid`)).status, 401)
  assert.deepEqual(await (await fetch(`${base}/booths/1`)).json(), { images: [], missingCount: 0 })
  assert.deepEqual(calls, [])
  const post = (body: object, extra = {}) => fetch(`${base}/start`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  assert.equal((await post({ mode: 'missing' }, { Origin: 'https://other.invalid' })).status, 403)
  assert.equal((await post({ mode: 'missing', userId: 'other' })).status, 400)
  assert.equal((await post({ mode: 'missing' })).status, 202)
  assert.equal((await finished(service)).status, 'succeeded')
  assert.deepEqual(store.scopes, [{ userId: 'owner', missingOnly: true }])
  const gallery = await (await fetch(`${base}/booths/1`)).json()
  const image = await fetch(new URL(gallery.images[0].url, base))
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
  assert.equal((await fetch(`${base}/images/11/bad.svg`)).status, 400)
  source.latest = async () => [twitterImage('14'), twitterImage('11')]
  const liveResponse = await fetch(`${base}/live/booths/1`, { headers })
  assert.equal(liveResponse.status, 200)
  assert.match(liveResponse.headers.get('cache-control')!, /private/)
  const live = await liveResponse.json()
  assert.equal(live.images.length, 2)
  const forwarded = await fetch(new URL(live.images[0].url, base), { headers })
  assert.equal(forwarded.status, 200)
  assert.equal(forwarded.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await forwarded.arrayBuffer()), png)
  assert.equal((await fetch(`${base}/live/images/invalid`, { headers })).status, 400)
  assert.equal((await post({ mode: 'missing' })).status, 202)
  assert.equal((await finished(service)).total, 0)
  store.row.updatedAt = null
  source.latest = async () => { throw new TwitterAccessError('Twitter HTTP 429') }
  await post({ mode: 'refresh' })
  assert.equal((await finished(service)).status, 'failed')
  assert.deepEqual(store.records, ['14', '11'])
})

test('MySQL Twitter migration, numeric ID preservation/invalidation, index and favorite ownership',
  { skip: !db && 'Requires server .env' }, async t => {
    t.after(() => pool!.end())
    const id = `${Date.now()}99201`, userId = randomUUID(), twitterId = `${Date.now()}99211`
    const handle = `t${Date.now()}`
    try {
      await db!.insert(users).values({ id: userId, username: `tw_${userId.slice(0, 20)}`, password_hash: 'test', created_at: new Date() })
      const [owner] = await db!.select().from(users).where(eq(users.id, userId))
      const catalog = new MysqlJobRepository(), store = new MysqlTwitterStore()
      const booth = {
        id, event_id: '9999', comiket: 9999, circle_name: 'Synthetic Twitter fixture',
        weekday: '土', hall: '東', island_code: 'ア', booth_number: '01',
        twitter_id: handle, images: '[]', source_url: 'https://example.invalid/', last_crawled_at: '2026-11-18 00:00:00',
      }
      await catalog.saveBooth(booth)
      await db!.insert(userFavorites).values({ user_id: owner!.internal_id, booth_id: id, colour: '#FF0000', memo: '' })
      assert.deepEqual(await store.favorites(userId, true), [id])
      assert.deepEqual(await store.favorites(randomUUID(), true), [])
      await db!.update(userFavorites).set({ colour: null }).where(eq(userFavorites.user_id, owner!.internal_id))
      assert.deepEqual(await store.favorites(userId, false), [])
      await db!.update(userFavorites).set({ colour: '#FF0000' }).where(eq(userFavorites.user_id, owner!.internal_id))
      await store.resolve(handle, twitterId)
      const imageIds = Array.from({ length: 4 }, (_, i) => String(BigInt(twitterId) + BigInt(i + 1)))
      await store.complete(twitterId, [
        { ...twitterImage(imageIds[3]!), tweetId: '100', publishedAt: new Date('2020-01-01T00:00:00Z') },
        { ...twitterImage(imageIds[0]!, 1), tweetId: '200' },
        { ...twitterImage(imageIds[1]!, 0), tweetId: '200' },
        { ...twitterImage(imageIds[2]!, 0), tweetId: '199' },
      ], new Date('2026-11-18T00:00:00Z'))
      assert.deepEqual(await new MysqlTwitterStore().images(twitterId), [imageIds[1], imageIds[0], imageIds[2], imageIds[3]])
      const [saved] = await db!.select().from(imagesTwitter).where(eq(imagesTwitter.image_id, imageIds[0]!))
      assert.equal(saved!.tweet_id, '200')
      assert.equal(saved!.media_index, 1)
      assert.equal(saved!.tweet_created_at!.toISOString(), '2026-11-18T00:00:00.000Z')
      assert.deepEqual(await store.favorites(userId, true), [])
      const completedAt = (await store.booth(id))!.updatedAt
      await store.replace(twitterId, [twitterImage(imageIds[0]!)])
      assert.deepEqual(await store.images(twitterId), [imageIds[0]])
      assert.equal((await store.booth(id))!.updatedAt!.getTime(), completedAt!.getTime())
      await catalog.saveBooth({ ...booth, twitter_id: handle.toUpperCase() })
      assert.equal((await store.booth(id))!.numberId, twitterId)
      assert.ok((await store.booth(id))!.updatedAt)
      await catalog.saveBooth({ ...booth, twitter_id: `${handle}x` })
      assert.equal((await store.booth(id))!.numberId, null)
      assert.equal((await store.booth(id))!.updatedAt, null)
    } finally {
      await db!.delete(imagesTwitter).where(eq(imagesTwitter.twitter_number_id, twitterId))
      await db!.delete(users).where(eq(users.id, userId))
      await db!.delete(booths).where(eq(booths.id, id))
    }
  })
