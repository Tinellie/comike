import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MapBoothLookup } from '../../client/src/map/boothLookup.ts'

const hit = { hallGroup: '東123', island: 'ア', number: '73', suffix: 'a' as const }
const result = { circles: [], vacancy: null }

test('hover and click share the pending request and reuse a successful location response', async t => {
  let resolve!: (response: Response) => void
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise<Response>(done => { resolve = done }))
  const lookup = new MapBoothLookup('240', '火')
  const hover = lookup.load(hit), click = lookup.load({ ...hit })
  assert.equal(hover, click)
  assert.equal(fetch.mock.callCount(), 1)
  resolve(Response.json(result))
  assert.deepEqual(await hover, result)
  assert.equal(lookup.load(hit), hover)
  assert.equal(fetch.mock.callCount(), 1)
  lookup.dispose()
})

test('failed hover requests are evicted so a later hover or click can retry', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => ++attempts === 1
    ? Response.json({ message: 'test unavailable' }, { status: 503 }) : Response.json(result))
  const lookup = new MapBoothLookup('240', '火')
  await assert.rejects(lookup.load(hit), /test unavailable/)
  assert.deepEqual(await lookup.load(hit), result)
  assert.equal(attempts, 2)
  lookup.dispose()
})

test('location caches distinguish half booths and dates, and dispose cancels pending requests', async t => {
  const queries: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    queries.push(String(input))
    if (queries.length < 4) return Response.json(result)
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('test aborted')), { once: true })
    })
  })
  const first = new MapBoothLookup('240', '火'), second = new MapBoothLookup('240', '水')
  await first.load(hit)
  await first.load({ ...hit, suffix: 'b' })
  await second.load(hit)
  assert.equal(new Set(queries).size, 3)
  const pending = first.load({ ...hit, number: '74' })
  const rejected = assert.rejects(pending, /test aborted/)
  first.dispose()
  await rejected
  second.dispose()
})

test('previews cache pending and decoded images across positions, and disposal clears them', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  let decodes = 0
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    src = ''
    async decode() { decodes++ }
  } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'Image', previous)
    else Reflect.deleteProperty(globalThis, 'Image')
  })
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    circles: [{ imageUrls: ['/test.png', '/test.png'] }], vacancy: null,
  }))
  const lookup = new MapBoothLookup('240', '火')
  const first = lookup.preview(hit)
  assert.equal(lookup.preview({ ...hit }), first)
  await first
  await lookup.preview({ ...hit, suffix: 'b' })
  await lookup.load(hit)
  assert.equal(fetch.mock.callCount(), 2)
  assert.equal(decodes, 1)
  assert.equal(lookup.preview(hit), first)
  lookup.dispose()
  await lookup.preview(hit)
  assert.equal(decodes, 2)
  lookup.dispose()
})

test('failed image decoding retries without repeating successful data queries', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  let decodes = 0
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    src = ''
    async decode() { if (++decodes === 1) throw new Error('test image unavailable') }
  } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'Image', previous)
    else Reflect.deleteProperty(globalThis, 'Image')
  })
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    circles: [{ imageUrls: ['/test.png'] }], vacancy: null,
  }))
  const lookup = new MapBoothLookup('240', '火')
  await assert.rejects(lookup.preview(hit), /图片加载失败/)
  await lookup.preview(hit)
  assert.equal(decodes, 2)
  assert.equal(fetch.mock.callCount(), 1)
  lookup.dispose()
})
