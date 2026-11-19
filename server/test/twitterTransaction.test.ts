import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { ResourceType, Rettiwt } from 'rettiwt-api'

// Rettiwt uses the CommonJS copy; the ESM entry exports a different class.
const { ClientTransaction } = createRequire(import.meta.url)('x-client-transaction-id') as typeof import('x-client-transaction-id')
const apiKey = Buffer.from('auth_token=test;ct0=test;twid="u=11";').toString('base64')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(t: TestContext, options: {
  initialize?: () => Promise<void>
  generate?: () => Promise<void>
  respond?: (index: number) => Promise<Response>
  maxRetries?: number
} = {}) {
  const state = { homepages: 0, initializations: 0, headers: [] as (string | null)[], generated: [] as string[] }
  const statuses: number[] = []
  t.mock.method(ClientTransaction.prototype, 'initialize', async () => {
    state.initializations++
    await options.initialize?.()
  })
  t.mock.method(ClientTransaction.prototype, 'generateTransactionId', async (method: string, path: string) => {
    await options.generate?.()
    state.generated.push(`${method} ${path}`)
    return `tid-${state.generated.length}`
  })
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname === '/i/jf/') {
      state.homepages++
      return new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
    }
    state.headers.push(request.headers.get('x-client-transaction-id'))
    return options.respond ? options.respond(state.headers.length)
      : new Response('{}', { status: statuses.shift() ?? 200, headers: { 'content-type': 'application/json' } })
  }
  const client = () => new Rettiwt({
    apiKey, proxy: null, fetch: fetcher, maxRetries: options.maxRetries ?? 0,
    errorHandler: { handle(error: unknown) { throw error } },
  }).user
  const user = client()
  const request = (id = '11') => user.request(ResourceType.USER_MEDIA, { id, count: 20 })
  return { state, statuses, client, request }
}

test('transaction materials are reused across target accounts, but every request has a fresh ID', async t => {
  const { state, request, client } = fixture(t)
  await request()
  await request('22')
  await request()
  assert.equal(state.homepages, 1)
  assert.equal(state.initializations, 1)
  assert.deepEqual(state.headers, ['tid-1', 'tid-2', 'tid-3'])
  assert.ok(state.generated.every(value => value.startsWith('GET /i/api/graphql/') && value.endsWith('/UserMedia')))

  await client().request(ResourceType.USER_MEDIA, { id: '11', count: 20 })
  assert.equal(state.homepages, 2, 'separate configured instances must not share initialization')
})

test('concurrent requests share one in-flight initialization', async t => {
  const entered = deferred<void>(), release = deferred<void>()
  const { state, request } = fixture(t, { initialize: async () => { entered.resolve(); await release.promise } })
  const first = request()
  await entered.promise
  const second = request('22')
  release.resolve()
  await Promise.all([first, second])
  assert.equal(state.homepages, 1)
  assert.equal(state.initializations, 1)
  assert.equal(new Set(state.headers).size, 2)
})

test('transaction cache expires one hour after successful initialization', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const { state, request } = fixture(t, { initialize: async () => { now += 1_000 } })
  await request()
  now += 3_600_000 - 1
  await request()
  assert.equal(state.homepages, 1)
  now++
  await request()
  assert.equal(state.homepages, 2)
  assert.equal(state.initializations, 2)
})

test('failed initialization or ID generation is reported and does not poison the cache', async t => {
  for (const phase of ['initialize', 'generate'] as const) {
    await t.test(phase, async t => {
      let first = true
      const { state, request } = fixture(t, {
        [phase]: async () => {
          if (first) { first = false; throw new Error(`fixture ${phase} failure`) }
        },
      })
      await assert.rejects(request(), new RegExp(`fixture ${phase} failure`))
      await request()
      assert.equal(state.homepages, 2)
      assert.equal(state.headers.length, 1)
    })
  }
})

test('HTTP failures preserve stop/retry behavior and invalidate only rejected materials', async t => {
  for (const status of [400, 401, 403, 404, 429, 503]) {
    await t.test(String(status), async t => {
      const { state, statuses, request } = fixture(t)
      statuses.push(status)
      await assert.rejects(request(), error =>
        error instanceof Error && 'status' in error && error.status === status)
      assert.equal(state.headers.length, 1, 'must not automatically replay authentication or rate-limit failures')
      await request()
      assert.equal(state.homepages, [400, 401, 403, 404].includes(status) ? 2 : 1)
      assert.deepEqual(state.headers, ['tid-1', 'tid-2'])
    })
  }
})

test('existing 404 retry refreshes materials and sends the newly generated ID', async t => {
  const { state, statuses, request } = fixture(t, { maxRetries: 2 })
  statuses.push(404, 200)
  await request()
  assert.equal(state.homepages, 2)
  assert.deepEqual(state.headers, ['tid-1', 'tid-2'])
})

test('a late failure from an expired entry cannot invalidate a newer cache entry', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const started = deferred<void>(), response = deferred<Response>()
  const { state, request } = fixture(t, {
    respond: async index => {
      if (index === 1) { started.resolve(); return response.promise }
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
  const first = assert.rejects(request(), /401/)
  await started.promise
  now += 3_600_000
  await request('22')
  response.resolve(new Response('{}', { status: 401 }))
  await first
  await request('33')
  assert.equal(state.homepages, 2)
  assert.deepEqual(state.headers, ['tid-1', 'tid-2', 'tid-3'])
})
