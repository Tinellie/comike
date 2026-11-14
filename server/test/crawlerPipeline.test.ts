import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { collectDetails } from '../src/crawler/details.js'
import type { collectList } from '../src/crawler/list.js'
import { CrawlerService } from '../src/crawler/service.js'
import type { LoginSession } from '../src/crawler/login.js'
import type { CircleListCache, CrawlJob, JobRepository } from '../src/crawler/types.js'
import { parseDetail } from '../src/crawler/parser.js'
import type { Booth } from '../src/db/schema.js'

const fixture = await readFile(new URL('../../ref/circle-detail.html', import.meta.url), 'utf8')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=', 'base64')

class Repository implements JobRepository {
  job: CrawlJob | null = null
  records = new Map<string, Booth>()
  snapshots: CrawlJob[] = []
  cache: CircleListCache | null = null
  async check() {}
  async load() { return this.job ? structuredClone(this.job) : null }
  async save(job: CrawlJob) {
    this.job = structuredClone(job)
    this.snapshots.push(this.job)
  }
  async saveBooth(booth: Booth) { this.records.set(booth.id, structuredClone(booth)) }
  async loadList() { return this.cache ? structuredClone(this.cache) : null }
  async saveList(cache: CircleListCache) { this.cache = structuredClone(cache) }
  async resetRecords() {
    const count = this.records.size
    this.records.clear()
    this.job = null
    return count
  }
  async savedBooths(ids: string[]) {
    const wanted = new Set(ids)
    const saved = [...this.records.values()].filter(booth => wanted.has(booth.id))
    return { records: saved, sample: saved[0] ?? null }
  }
}

function session(): LoginSession {
  let generation = 1
  return {
    get generation() { return generation },
    status: () => ({ authenticated: true, open: false, width: 1280, height: 800 }),
    open: async () => {},
    confirm: async () => {},
    invalidate: () => {},
    waitForLogin: async signal => { signal.throwIfAborted(); generation++ },
    storageState: async () => ({ cookies: [], origins: [] }),
    cookieHeader: async () => `session=${generation}`,
    screenshot: async () => png,
    input: async () => {},
    clear: async () => {},
    close: async () => {},
  }
}

async function finished(service: CrawlerService) {
  const deadline = Date.now() + 30_000
  while (service.active) {
    if (Date.now() > deadline) throw new Error('Crawler pipeline did not finish in time')
    await delay(20)
  }
  return service.status()
}

test('successful completed crawls reconcile map vacancies and reconciliation errors remain explicit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-reconcile-pipeline-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const repository = new Repository()
  const booth = parseDetail(fixture, '24031654').booth
  repository.records.set(booth.id, booth)
  repository.cache = { ids: [booth.id], eventId: booth.event_id, comiket: booth.comiket, completedAt: new Date().toISOString() }
  let reconciliations = 0
  let reject = false
  const service = new CrawlerService(session(), repository, directory, join(directory, 'work'), {
    list: async () => { throw new Error('Complete cache should bypass listing') },
    details: async () => { throw new Error('Saved circles should bypass details') },
  }, async eventId => {
    assert.equal(eventId, booth.event_id)
    reconciliations++
    if (reject) throw new Error('Map fixture unavailable')
  })
  t.after(() => service.close())
  await service.start()
  assert.equal((await finished(service)).status, 'completed')
  assert.equal(reconciliations, 1)
  reject = true
  await service.start()
  const failure = await finished(service)
  assert.equal(failure.status, 'failed')
  assert.match(failure.action, /Map fixture unavailable/)
  assert.equal(reconciliations, 2)
})

test('full pipeline: exactly five simultaneous detail requests, images, progress, failure retry and persisted resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-pipeline-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ids = Array.from({ length: 6 }, (_, index) => String(24031001 + index))
  const attempts = new Map<string, number>()
  let active = 0
  let peak = 0
  let rejectLast = true
  let releaseFirstBatch: () => void = () => {}
  const firstBatch = new Promise<void>(resolve => { releaseFirstBatch = resolve })
  const server = createServer(async (request, response) => {
    const id = request.url!.split('/').at(-1)!
    attempts.set(id, (attempts.get(id) ?? 0) + 1)
    active++
    peak = Math.max(peak, active)
    if (active === 5) releaseFirstBatch()
    await firstBatch
    await delay(30)
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (rejectLast && id === ids.at(-1)) {
      response.statusCode = 503
      response.end('Temporary upstream failure')
    } else {
      response.end(fixture.replaceAll('24031654', id))
    }
    active--
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    releaseFirstBatch()
    server.closeAllConnections()
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.mock.method(globalThis, 'fetch', async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }))
  const repository = new Repository()
  let listRuns = 0
  const runners = {
    list: async (options: Parameters<typeof collectList>[0]) => {
      listRuns++
      await options.progress(ids, null, 'Listing fixture records')
      return { ids, eventId: null }
    },
    details: (options: Parameters<typeof collectDetails>[0]) => collectDetails({
      ...options,
      requests: options.requests.map(request => ({ ...request, url: `${base}/Circle/${request.id}` })),
    }),
  }
  const service = new CrawlerService(session(), repository, directory, join(directory, 'work'), runners)
  t.after(() => service.close())
  await service.start()
  const failed = await finished(service)
  assert.equal(peak, 5)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.succeeded, 5)
  assert.equal(failed.failed, 1)
  assert.equal(failed.processed, 6)
  assert.equal(attempts.get(ids.at(-1)!), 3)
  assert.ok(failed.sample)
  assert.ok(repository.snapshots.some(job => job.status === 'listing'))
  assert.ok(repository.snapshots.some(job => job.status === 'details' && job.completedIds.length > 0))
  const completedAttempts = attempts.get(ids[0]!)
  rejectLast = false
  const restored = new CrawlerService(session(), repository, directory, join(directory, 'work'), runners)
  t.after(() => restored.close())
  await restored.start(true)
  const completed = await finished(restored)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.succeeded, 6)
  assert.equal(completed.failed, 0)
  assert.equal(listRuns, 1)
  assert.equal(attempts.get(ids[0]!), completedAttempts)
  assert.equal(repository.records.size, 6)
  assert.equal(repository.job?.eventId, '240')
  for (const [id, booth] of repository.records) {
    assert.equal(typeof booth.images, 'string')
    assert.deepEqual(JSON.parse(booth.images), [`${id}_1.png`, `${id}_2.png`])
    assert.equal(booth.comiket, 109)
    assert.equal(booth.weekday.length, 1)
    assert.equal(booth.circle_appeal, parseDetail(fixture, '24031654').booth.circle_appeal)
    assert.equal(booth.tags, null)
    assert.equal('location' in booth, false)
  }
  const files = await readdir(join(directory, 'booths', 'c109'), { withFileTypes: true })
  assert.equal(files.length, 12)
  assert.ok(files.every(file => file.isFile() && file.name.endsWith('.png')))
  assert.ok(files.every(file => /_[12]\.png$/.test(file.name)))
})

test('complete cache is reused across new jobs; database, not stale completed IDs, controls resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-database-resume-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }))
  const ids = ['24031654', '24031655', '24031656']
  const repository = new Repository()
  const saved = parseDetail(fixture, ids[0]!).booth
  saved.images = '["24031654_2.png"]'
  repository.records.set(saved.id, saved)
  repository.cache = { ids, eventId: '240', comiket: 109, completedAt: new Date().toISOString() }
  let listRuns = 0
  const requested: string[][] = []
  const runners = {
    list: async () => { listRuns++; return { ids, eventId: '240' } },
    details: async (options: Parameters<typeof collectDetails>[0]) => {
      requested.push(options.requests.map(request => request.id))
      for (const request of options.requests) await options.process(request.id, fixture.replaceAll('24031654', request.id))
    },
  }
  const service = new CrawlerService(session(), repository, directory, join(directory, 'work'), runners)
  t.after(() => service.close())
  await service.start()
  assert.equal((await finished(service)).succeeded, 3)
  assert.equal(listRuns, 0)
  assert.deepEqual(requested[0], ids.slice(1))
  assert.ok(repository.job)
  repository.records.delete(ids[1]!)
  repository.job.completedIds = [ids[1]!]
  repository.job.failures = { [ids[0]!]: 'Stale failure despite a successful database save' }
  const restored = new CrawlerService(session(), repository, directory, join(directory, 'work'), runners)
  t.after(() => restored.close())
  await restored.start(true)
  assert.equal((await finished(restored)).succeeded, 3)
  assert.deepEqual(requested[1], [ids[1]!])
  repository.records.clear()
  await restored.start()
  assert.equal((await finished(restored)).succeeded, 3)
  assert.deepEqual(requested[2], ids)
  assert.equal(listRuns, 0)
  await restored.start(false, true)
  assert.equal((await finished(restored)).status, 'completed')
  assert.equal(listRuns, 1)
  assert.deepEqual((await restored.status()).listCache?.total, 3)
})

test('an interrupted partial list is never published as a complete cache', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-incomplete-cache-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const repository = new Repository()
  let listRuns = 0
  const service = new CrawlerService(session(), repository, directory, join(directory, 'work'), {
    list: async options => {
      listRuns++
      await options.progress(['24031654'], null, 'Partial row')
      throw new Error('A remaining list page failed')
    },
    details: async () => { assert.fail('Details cannot run from an incomplete list') },
  })
  t.after(() => service.close())
  await service.start()
  assert.equal((await finished(service)).status, 'failed')
  assert.equal(repository.cache, null)
  await service.start(true)
  assert.equal((await finished(service)).status, 'failed')
  assert.equal(repository.cache, null)
  assert.equal(listRuns, 2)
})

test('details can process more than the old 60-per-minute limit with five workers', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-detail-rate-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<h1>Detail</h1>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const { Configuration } = await import('crawlee')
  const processed = new Set<string>()
  const start = Date.now()
  await collectDetails({
    requests: Array.from({ length: 65 }, (_, id) => ({ id: String(id), url: `http://127.0.0.1:${address.port}/Circle/${id}` })),
    login: session(),
    config: new Configuration({ persistStorage: false, purgeOnStart: false, storageClientOptions: { localDataDirectory: directory } }),
    signal: AbortSignal.timeout(25_000),
    beforeRequest: async () => {},
    loginRequired: async () => { assert.fail('No login should be needed') },
    process: async id => { processed.add(id) },
    failed: async (_id, error) => { throw error },
  })
  assert.equal(processed.size, 65)
  assert.ok(Date.now() - start < 25_000)
})

for (const expired of ['html', '401', '403', 'redirect'] as const) {
test(`detail ${expired} login expiry refreshes cookies and retries the same record without dropping it`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-detail-expiry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.headers.cookie === 'session=1') {
      if (expired === '401' || expired === '403') response.statusCode = Number(expired)
      if (expired === 'redirect' && request.url !== '/Account/Login') {
        response.statusCode = 302
        response.setHeader('Location', '/Account/Login')
      }
      response.end('<input type="password">')
    } else response.end('<h1>Authorized detail</h1>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const login = session()
  let prompts = 0
  const processed: string[] = []
  const { Configuration } = await import('crawlee')
  await collectDetails({
    requests: [{ id: '123', url: `http://127.0.0.1:${address.port}/Circle/123` }],
    login,
    config: new Configuration({ persistStorage: false, purgeOnStart: false, storageClientOptions: { localDataDirectory: directory } }),
    signal: new AbortController().signal,
    beforeRequest: async () => {},
    loginRequired: async generation => {
      if (generation === login.generation) {
        prompts++
        await login.waitForLogin(new AbortController().signal)
      }
    },
    process: async (id, html) => { assert.match(html, /Authorized/); processed.push(id) },
    failed: async (_id, error) => { throw error },
  })
  assert.equal(prompts, 1)
  assert.equal(requests, expired === 'redirect' ? 3 : 2)
  assert.deepEqual(processed, ['123'])
})
}
