import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { tokenHash } from '../src/auth/routes.js'
import { MysqlPixivStore } from '../src/social/pixiv/repository.js'
import type { PixivBooth, PixivStore } from '../src/social/pixiv/repository.js'
import { PixivAppSource } from '../src/social/pixiv/appSource.js'
import type { PixivSource } from '../src/social/pixiv/source.js'
import { PIXIV_MIN_UPDATE_INTERVAL, PixivConflictError, PixivService } from '../src/social/pixiv/service.js'
import { PixivStorage } from '../src/social/pixiv/storage.js'
import { MemoryAuthStore } from './authFixture.js'
import { db, pool } from '../src/db/index.js'
import { booths, imagesPixiv, userFavorites, users } from '../src/db/schema.js'
import type { Booth } from '../src/db/schema.js'
import { MysqlJobRepository } from '../src/crawler/repository.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const now = new Date('2026-11-18T00:00:00Z')
async function waitForJob(service: PixivService, userId: string) {
  for (let i = 0; i < 100; i++) {
    const state = service.status(userId)
    if (state.status !== 'running') return state
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Pixiv job did not finish')
}
class MemoryPixivStore implements PixivStore {
  booths = new Map<string, PixivBooth>([['1', { id: '1', pixivId: '11', updatedAt: null }]])
  records = new Map<string, string[]>()
  scopes: { userId: string; missingOnly: boolean }[] = []
  async booth(id: string) { return this.booths.get(id) ?? null }
  async favorites(userId: string, missingOnly: boolean) {
    this.scopes.push({ userId, missingOnly })
    return [...this.booths.values()].filter(booth => booth.pixivId && (!missingOnly || !booth.updatedAt)).map(booth => booth.id)
  }
  async images(id: string) { return this.records.get(id) ?? [] }
  async replace(id: string, ids: string[]) { this.records.set(id, [...ids]) }
  async saveImage(id: string, imageId: string) {
    this.records.set(id, [...new Set([...(this.records.get(id) ?? []), imageId])])
  }
  async touch(id: string, date: Date) {
    for (const booth of this.booths.values()) if (booth.pixivId === id) booth.updatedAt = date
  }
}

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'comike-pixiv-'))
  const storage = new PixivStorage(directory)
  const store = new MemoryPixivStore()
  const calls: string[] = []
  const source: PixivSource = {
    async latest(id) { calls.push(`latest:${id}`); return ['12', '11'] },
    async image(_id, imageId) { calls.push(`image:${imageId}`); return { body: png, extension: 'png' } },
  }
  const service = new PixivService(store, source, storage, () => now)
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, storage, store, source, service, calls }
}

test('live manifest immediately reuses indexed files and proxies missing images before background persistence completes', async t => {
  const { service, source, store, storage, calls } = await fixture(t)
  const cached = await storage.stage('11', '11', png, 'png')
  await cached.commit()
  await store.saveImage('11', '11')
  source.latestImages = async () => ['12', '11'].map(id => ({ id, url: `https://i.pximg.net/square/${id}.png` }))
  const stage = storage.stage.bind(storage)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(storage, 'stage', async (...args: Parameters<PixivStorage['stage']>) => {
    await gate
    return stage(...args)
  })
  let downloads = 0
  source.download = async url => {
    assert.equal(url, 'https://i.pximg.net/square/12.png')
    downloads++
    return { body: png, extension: 'png' }
  }
  const result = await service.liveGallery('1', new AbortController().signal)
  assert.equal(result!.images[1]!.url, '/api/social/pixiv/images/11/11.png')
  assert.equal(result!.missingCount, 1)
  assert.deepEqual(calls, [])
  assert.equal(downloads, 0, 'Returning the list must not wait for missing images')
  const token = result!.images[0]!.url.split('/').at(-1)!
  try {
    const [first, second] = await Promise.all([service.liveImage(token), service.liveImage(token)])
    assert.deepEqual(first.body, png)
    assert.deepEqual(second.body, png)
    assert.equal(downloads, 1)
    assert.deepEqual(await store.images('11'), ['11'], 'Slow disk writes must not block image delivery')
    await assert.rejects(service.liveImage(`${token}bad`), /图片链接无效/)
  } finally { release() }
  await service.close()
  assert.deepEqual(await store.images('11'), ['11', '12'])
  assert.deepEqual((await storage.list('11')).map(file => file.id), ['12', '11'])
  assert.equal(store.booths.get('1')!.updatedAt, null)
})

test('live images share a three-download limit and persist each image independently', async t => {
  const { service, source, store, storage } = await fixture(t)
  source.latestImages = async () => ['15', '14', '13', '12', '11'].map(id => ({ id, url: `https://i.pximg.net/${id}.png` }))
  let active = 0, maximum = 0, started = 0, release!: () => void, ready!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const firstThree = new Promise<void>(resolve => { ready = resolve })
  source.download = async () => {
    active++; started++; maximum = Math.max(maximum, active)
    if (started === 3) ready()
    await gate
    active--
    return { body: png, extension: 'png' }
  }
  const manifest = await service.liveGallery('1', new AbortController().signal)
  const downloads = manifest!.images.map(image => service.liveImage(image.url.split('/').at(-1)!))
  try {
    await firstThree
    assert.equal(started, 3)
    assert.equal(maximum, 3)
  } finally { release() }
  await Promise.all(downloads)
  await service.close()
  assert.equal((await store.images('11')).length, 5)
  assert.equal((await storage.list('11')).length, 5)
})

test('partially populated indexed cache does not restore a full-check timestamp or skip a batch refresh', async t => {
  const { service, store, storage, calls } = await fixture(t)
  const cached = await storage.stage('11', '11', png, 'png')
  await cached.commit()
  await store.saveImage('11', '11')
  await service.checkBooth('1')
  assert.deepEqual(calls, ['latest:11', 'image:12'])
  assert.deepEqual(await store.images('11'), ['12', '11'])
  assert.equal((await service.gallery('1'))!.images.length, 2)
})

test('Cloudflare challenges and access denial stop the batch immediately without changing stored images or checking other artists', async t => {
  const { store, storage } = await fixture(t)
  store.booths.set('2', { id: '2', pixivId: '22', updatedAt: null })
  for (const [status, headers, message] of [
    [403, { 'cf-mitigated': 'challenge' }, /Cloudflare/],
    [403, {}, /App API 访问被拒绝/],
  ] as const) {
    let requests = 0
    const source = new PixivAppSource({ accessToken: 'test-token' }, async () => {
      requests++
      return new Response('Access restricted', { status, headers })
    })
    const service = new PixivService(store, source, storage, () => now)
    try {
      service.start('owner', false)
      const state = await waitForJob(service, 'owner')
      assert.equal(state.status, 'failed')
      assert.equal(state.total, 2)
      assert.equal(state.completed, 1)
      assert.equal(state.failed, 1)
      assert.match(state.message!, message)
      assert.equal(requests, 1, 'A global access failure must not be retried against every artist')
      assert.equal(store.booths.get('1')!.updatedAt, null)
      assert.equal(store.booths.get('2')!.updatedAt, null)
      assert.deepEqual(await store.images('11'), [])
    } finally { await service.close() }
  }
})

test('first crawl downloads works, uses shared artist timestamps, skips within one hour and checks again exactly at the boundary', async t => {
  const { service, store, calls, storage } = await fixture(t)
  store.booths.set('2', { id: '2', pixivId: '11', updatedAt: null })
  assert.equal(await service.checkBooth('1'), 'updated')
  assert.deepEqual(calls, ['latest:11', 'image:12', 'image:11'])
  assert.deepEqual(await store.images('11'), ['12', '11'])
  assert.equal(store.booths.get('2')!.updatedAt?.getTime(), now.getTime())
  assert.deepEqual((await service.gallery('1'))!.images.map(image => image.id), ['12', '11'])
  const files = await storage.list('11')
  assert.equal(files.length, 2)
  assert.deepEqual(await readFile(join(storage.directory('11'), files[0]!.name)), png)
  assert.equal(await service.checkBooth('2'), 'skipped')
  assert.equal(calls.length, 3)
  store.booths.get('1')!.updatedAt = new Date(now.getTime() - PIXIV_MIN_UPDATE_INTERVAL + 1)
  assert.equal(await service.checkBooth('1'), 'skipped')
  store.booths.get('1')!.updatedAt = new Date(now.getTime() - PIXIV_MIN_UPDATE_INTERVAL)
  assert.equal(await service.checkBooth('1'), 'updated')
  assert.deepEqual(calls, ['latest:11', 'image:12', 'image:11', 'latest:11'])
  assert.equal(store.booths.get('1')!.updatedAt?.getTime(), now.getTime())
})

test('restores absent crawl history/index from local download mtimes, with no network until stale', async t => {
  const { storage, service, calls, store, source } = await fixture(t)
  await mkdir(storage.directory('11'), { recursive: true })
  const downloaded = new Date(now.getTime() - 10_000)
  await writeFile(join(storage.directory('11'), '12_p0.png'), png)
  await utimes(join(storage.directory('11'), '12_p0.png'), downloaded, downloaded)
  assert.equal(await service.checkBooth('1'), 'skipped')
  assert.equal(store.booths.get('1')!.updatedAt?.getTime(), downloaded.getTime())
  assert.deepEqual(await store.images('11'), ['12'])
  assert.deepEqual(calls, [])
  const old = new Date(now.getTime() - PIXIV_MIN_UPDATE_INTERVAL - 1)
  store.booths.get('1')!.updatedAt = null
  await utimes(join(storage.directory('11'), '12_p0.png'), old, old)
  t.mock.method(source, 'latest', async () => [])
  assert.equal(await service.checkBooth('1'), 'updated')
  assert.deepEqual(await store.images('11'), [])
  assert.deepEqual(await storage.list('11'), [])
  assert.equal(store.booths.get('1')!.updatedAt?.getTime(), now.getTime(), 'An empty public works list is still a successful check')
})

test('retains exactly the latest ten works, repairs missing indexed files and does not redownload existing pictures', async t => {
  const { storage, service, source, store, calls } = await fixture(t)
  const latest = Array.from({ length: 10 }, (_, i) => String(20 - i))
  await mkdir(storage.directory('11'), { recursive: true })
  await writeFile(join(storage.directory('11'), '20.png'), png)
  await writeFile(join(storage.directory('11'), '1.png'), png)
  await writeFile(join(storage.directory('11'), '20_p0.png'), png)
  store.records.set('11', ['20', '19', '1'])
  store.booths.get('1')!.updatedAt = new Date(now.getTime() - PIXIV_MIN_UPDATE_INTERVAL)
  assert.equal((await service.gallery('1'))!.missingCount, 1)
  t.mock.method(source, 'latest', async () => latest)
  await service.checkBooth('1')
  assert.deepEqual(await store.images('11'), latest)
  assert.deepEqual((await storage.list('11')).map(file => file.id), latest)
  assert.equal(calls.includes('image:20'), false)
  assert.equal(calls.includes('image:19'), true)
  assert.equal(calls.filter(call => call.startsWith('image:')).length, 9)
  assert.equal((await readdir(storage.directory('11'))).length, 10)
  assert.equal((await service.gallery('1'))!.missingCount, 0)
})

test('a failed download leaves previous files, index and timestamp intact and cleans staged temporary downloads', async t => {
  const { service, storage, store, source } = await fixture(t)
  await mkdir(storage.directory('11'), { recursive: true })
  await writeFile(join(storage.directory('11'), '1.png'), png)
  const previous = new Date(now.getTime() - PIXIV_MIN_UPDATE_INTERVAL)
  store.booths.get('1')!.updatedAt = previous
  store.records.set('11', ['1'])
  t.mock.method(source, 'image', async (_pixivId: string, id: string) => {
    if (id === '11') throw new Error('download failed')
    return { body: png, extension: 'png' }
  })
  await assert.rejects(service.checkBooth('1'), /download failed/)
  assert.deepEqual(await store.images('11'), ['1'])
  assert.deepEqual(await readdir(storage.directory('11')), ['1.png'])
  assert.equal(store.booths.get('1')!.updatedAt, previous)
  t.mock.method(source, 'image', async () => ({ body: png, extension: 'png' }))
  assert.equal(await service.checkBooth('1'), 'updated')
})

test('downloads up to three images concurrently and commits only after every download finishes', async t => {
  const { service, source, store, storage } = await fixture(t)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const threeStarted = new Promise<void>(resolve => { started = resolve })
  t.after(() => release())
  let active = 0, maximum = 0, count = 0
  const latest = ['20', '19', '18', '17', '16']
  t.mock.method(source, 'latest', async () => latest)
  t.mock.method(source, 'image', async () => {
    count++; active++; maximum = Math.max(maximum, active)
    if (count === 3) started()
    await gate
    active--
    return { body: png, extension: 'png' }
  })
  const task = service.checkBooth('1')
  await threeStarted
  assert.equal(count, 3)
  assert.deepEqual(await store.images('11'), [])
  assert.equal(store.booths.get('1')!.updatedAt, null)
  release()
  await task
  assert.equal(maximum, 3)
  assert.equal(count, 5)
  assert.deepEqual(await store.images('11'), latest)
  assert.equal((await storage.list('11')).length, 5)
})

test('failed parallel download waits for in-flight staging and removes all temporary files before rejecting', async t => {
  const { service, source, store, storage } = await fixture(t)
  let release!: () => void, failed!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const failureStarted = new Promise<void>(resolve => { failed = resolve })
  t.after(() => release())
  await mkdir(storage.directory('11'), { recursive: true })
  await writeFile(join(storage.directory('11'), '1.png'), png)
  store.records.set('11', ['1'])
  const previous = new Date(now.getTime() - PIXIV_MIN_UPDATE_INTERVAL)
  store.booths.get('1')!.updatedAt = previous
  t.mock.method(source, 'latest', async () => ['20', '19', '18', '17'])
  const calls: string[] = []
  t.mock.method(source, 'image', async (_pixivId: string, id: string) => {
    calls.push(id)
    if (id === '19') { failed(); throw new Error('parallel download failed') }
    await gate
    return { body: png, extension: 'png' }
  })
  const result = assert.rejects(service.checkBooth('1'), /parallel download failed/)
  await failureStarted
  release()
  await result
  assert.equal(calls.includes('17'), false)
  assert.deepEqual(await readdir(storage.directory('11')), ['1.png'])
  assert.deepEqual(await store.images('11'), ['1'])
  assert.equal(store.booths.get('1')!.updatedAt, previous)
})

test('coalesces overlapping checks for the same Pixiv account and reports partial batch failures', async t => {
  const { service, source, store, calls } = await fixture(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(source, 'latest', async () => { await gate; return ['12'] })
  store.booths.set('2', { id: '2', pixivId: '11', updatedAt: null })
  const first = service.checkBooth('1'), second = service.checkBooth('2')
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls, ['image:12'])
  store.booths.set('3', { id: '3', pixivId: 'bad', updatedAt: null })
  store.booths.set('4', { id: '4', pixivId: '33', updatedAt: null })
  t.mock.method(source, 'latest', async () => ['13'])
  service.start('owner', true)
  assert.throws(() => service.start('other', false), PixivConflictError)
  const result = await waitForJob(service, 'owner')
  assert.equal(result.status, 'failed')
  assert.equal(result.total, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.updated, 1)
  assert.deepEqual(store.scopes, [{ userId: 'owner', missingOnly: true }])
})

test('Pixiv endpoints scope batch jobs to the session, protect writes, and read galleries without starting crawls', async t => {
  const { service, source, store, calls, storage } = await fixture(t)
  const auth = new MemoryAuthStore()
  for (const [id, token] of [['first', 'a'], ['second', 'b']] as const) {
    auth.users.set(id, { id, username: id, isAdmin: false, passwordHash: '' })
    await auth.createSession(tokenHash(token.repeat(64)), id, new Date(Date.now() + 60_000))
  }
  const server = createApp({ checkDatabase: async () => {}, authStore: auth, pixiv: service }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/social/pixiv`
  const headers = { Cookie: `comike_session=${'a'.repeat(64)}`, 'Content-Type': 'application/json' }
  const post = (body: unknown, extra = {}) => fetch(`${base}/start`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  assert.equal((await fetch(`${base}/start`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/status`)).status, 401)
  assert.equal((await fetch(`${base}/live/booths/1`)).status, 401)
  assert.equal((await fetch(`${base}/STATUS/`)).status, 401)
  assert.equal((await post({ mode: 'refresh' }, { Origin: 'https://other.invalid' })).status, 403)
  for (const body of [null, [], {}, { mode: 'bad' }, { mode: 'refresh', userId: 'second' }]) {
    assert.equal((await post(body)).status, 400)
  }
  const before = await fetch(`${base}/booths/1`)
  assert.equal(before.status, 200)
  assert.deepEqual(await before.json(), { pixivId: '11', updatedAt: null, images: [], missingCount: 0 })
  assert.deepEqual(calls, [])
  assert.equal((await fetch(`${base}/booths/999`)).status, 404)
  assert.equal((await fetch(`${base}/booths/bad`)).status, 400)
  assert.equal((await fetch(`${base}/images/11/bad.svg`)).status, 400)
  assert.equal((await fetch(`${base}/images/11/1.png`)).status, 404)
  assert.equal((await post({ mode: 'missing' })).status, 202)
  assert.equal((await waitForJob(service, 'first')).status, 'succeeded')
  assert.deepEqual(store.scopes, [{ userId: 'first', missingOnly: true }])
  const gallery = await (await fetch(`${base}/booths/1`)).json()
  assert.equal(gallery.images.length, 2)
  const image = await fetch(new URL(gallery.images[0].url, base))
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
  const otherStatus = await fetch(`${base}/status`, { headers: { Cookie: `comike_session=${'b'.repeat(64)}` } })
  assert.equal((await otherStatus.json()).status, 'idle')
  assert.equal(otherStatus.headers.get('cache-control'), 'private, no-store')
  store.booths.get('1')!.updatedAt = new Date(now.getTime() - PIXIV_MIN_UPDATE_INTERVAL)
  t.mock.method(source, 'latest', async () => { throw new Error('Pixiv upstream unavailable') })
  assert.equal((await post({ mode: 'refresh' })).status, 202)
  const failed = await waitForJob(service, 'first')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.failed, 1)
  assert.match(failed.message!, /upstream unavailable/)
  assert.equal((await storage.list('11')).length, 2)
  assert.equal((await post({ mode: 'missing' })).status, 202)
  const completed = await waitForJob(service, 'first')
  assert.equal(completed.total, 0)
  assert.equal(completed.status, 'succeeded')
  source.latestImages = async () => [{ id: '99', url: 'https://i.pximg.net/square/99.png' }]
  source.download = async () => ({ body: png, extension: 'png' })
  const liveResponse = await fetch(`${base}/live/booths/1`, { headers })
  assert.equal(liveResponse.status, 200)
  const live = await liveResponse.json()
  assert.equal(live.images.length, 1)
  const proxy = await fetch(new URL(live.images[0].url, base), { headers })
  assert.equal(proxy.status, 200)
  assert.equal(proxy.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await proxy.arrayBuffer()), png)
  assert.equal((await fetch(`${base}/live/images/invalid`)).status, 401)
  assert.equal((await fetch(`${base}/live/images/invalid`, { headers })).status, 400)
})

test('MySQL Pixiv index enforces unique artwork ownership, scopes favorite targets and updates all booths sharing an artist',
  { skip: !db && 'Run with the server .env loaded for the MySQL integration check' }, async t => {
    t.after(() => pool!.end())
    const rollback = new Error('Rollback synthetic Pixiv records')
    await assert.rejects(db!.transaction(async tx => {
      const ownerId = randomUUID(), otherId = randomUUID(), prefix = `${Date.now()}993`
      await tx.insert(users).values([ownerId, otherId].map(id => ({
        id, username: `px_${id.slice(0, 20)}`, password_hash: 'test-only', created_at: new Date(),
      })))
      const [owner] = await tx.select({ id: users.internal_id }).from(users).where(eq(users.id, ownerId))
      const [other] = await tx.select({ id: users.internal_id }).from(users).where(eq(users.id, otherId))
      const first = `${prefix}01`, second = `${prefix}02`, third = `${prefix}03`, fourth = `${prefix}04`
      const pixiv = `${prefix}11`, another = `${prefix}22`, image = `${prefix}33`
      await tx.insert(booths).values([first, second, third, fourth].map((id, i) => ({
        id, event_id: prefix, comiket: 9999, circle_name: 'Synthetic Pixiv fixture',
        weekday: '土', hall: '東', island_code: 'ア', booth_number: '01',
        images: '[]', source_url: 'https://example.invalid/', last_crawled_at: '2026-11-18 00:00:00',
        pixiv_id: i < 2 ? pixiv : i === 2 ? another : null,
        pixiv_images_updated_at: i === 0 ? now : null,
      })))
      await tx.insert(userFavorites).values([
        { user_id: owner!.id, booth_id: first, colour: '#FF0000', memo: '' },
        { user_id: owner!.id, booth_id: second, colour: '#FF0000', memo: '' },
        { user_id: owner!.id, booth_id: fourth, colour: '#FF0000', memo: '' },
        { user_id: other!.id, booth_id: third, colour: '#0000FF', memo: '' },
      ])
      const store = new MysqlPixivStore(tx)
      assert.deepEqual(await store.favorites(ownerId, false), [first])
      assert.deepEqual(await store.favorites(ownerId, true), [second])
      assert.deepEqual(await store.favorites(otherId, false), [third])
      assert.deepEqual(await store.favorites(randomUUID(), false), [])
      assert.deepEqual(await store.booth(first), { id: first, pixivId: pixiv, updatedAt: now })
      assert.equal(await store.booth(`${prefix}99`), null)
      await store.replace(pixiv, [image])
      await store.saveImage(pixiv, image)
      const cachedImage = `${prefix}34`
      await store.saveImage(pixiv, cachedImage)
      assert.deepEqual((await store.images(pixiv)).sort(), [image, cachedImage].sort())
      await assert.rejects(store.saveImage(another, image), /作者不匹配/)
      await store.replace(pixiv, [image])
      assert.deepEqual(await store.images(pixiv), [image])
      await assert.rejects(store.replace(another, [image]), error =>
        error instanceof Error && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ER_DUP_ENTRY')
      assert.deepEqual(await store.images(pixiv), [image])
      assert.deepEqual(await store.images(another), [])
      await store.touch(pixiv, now)
      assert.equal((await store.booth(second))!.updatedAt?.getTime(), now.getTime())
      assert.equal((await store.booth(third))!.updatedAt, null)
      assert.deepEqual(await store.favorites(ownerId, true), [])
      await store.replace(pixiv, [])
      assert.deepEqual(await tx.select().from(imagesPixiv).where(eq(imagesPixiv.pixiv_id, pixiv)), [])
      throw rollback
    }), error => error === rollback)

    const id = `${Date.now()}99401`
    const record: Booth = {
      id, event_id: `${Date.now()}994`, comiket: 9999, circle_name: 'Synthetic Pixiv fixture',
      weekday: '土', hall: '東', island_code: 'ア', booth_number: '01',
      images: '[]', source_url: 'https://example.invalid/', last_crawled_at: '2026-11-18 00:00:00',
      pixiv_id: '11',
    }
    const catalog = new MysqlJobRepository(), store = new MysqlPixivStore()
    try {
      await catalog.saveBooth(record)
      await db!.update(booths).set({ pixiv_images_updated_at: now }).where(eq(booths.id, id))
      await catalog.saveBooth(record)
      assert.equal((await store.booth(id))!.updatedAt?.getTime(), now.getTime(), 'Catalog refresh preserves image history for an unchanged artist')
      await catalog.saveBooth({ ...record, pixiv_id: '22' })
      assert.equal((await store.booth(id))!.updatedAt, null, 'Changing the artist clears history so missing-only mode can collect it')
    } finally { await db!.delete(booths).where(eq(booths.id, id)) }
  })
