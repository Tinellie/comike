import assert from 'node:assert/strict'
import { test } from 'node:test'
import timers from 'node:timers/promises'
import { ProxyAgent } from 'undici'
import { PixivAppSource } from '../src/social/pixiv/appSource.js'
import { PixivAccessError } from '../src/social/pixiv/source.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const signal = () => AbortSignal.timeout(2000)
const auth = { refreshToken: 'test-refresh', clientId: 'test-client', clientSecret: 'test-secret' }
const work = (id: string, extra = {}) => ({ id, user: { id: '11' }, is_visible: true, x_restrict: 0, ...extra })
const list = (illusts: unknown[] = [], next_url: string | null = null) => Response.json({ illusts, next_url })

test('previews use only the API large URL for a single image or first manga page, without CDN credentials', async () => {
  for (const metadata of [
    { meta_single_page: { original_image_url: 'https://i.pximg.net/img-original/12_p0.png' } },
    { meta_pages: [{ image_urls: { original: 'https://i.pximg.net/img-original/12_p0.png' } }] },
  ]) {
    const requests: string[] = []
    let artwork = work('12', { ...metadata, image_urls: { large: 'https://i.pximg.net/img-master/12_p0_master1200.jpg' } })
    const source = new PixivAppSource({ accessToken: 'test-access' }, async (input, options) => {
      const url = new URL(String(input))
      requests.push(url.href)
      if (url.hostname === 'i.pximg.net') {
        assert.equal(url.pathname, '/img-master/12_p0_master1200.jpg')
        assert.equal(new Headers(options?.headers).get('authorization'), null)
        assert.equal(new Headers(options?.headers).get('referer'), 'https://www.pixiv.net/')
        return new Response(png)
      }
      assert.equal(url.pathname, '/v1/illust/detail')
      assert.equal(url.searchParams.get('illust_id'), '12')
      return Response.json({ illust: artwork })
    })
    assert.deepEqual(await source.large('11', '12', signal()), { body: png, extension: 'png' })
    assert.equal(requests.length, 2)
    artwork = work('12', { ...metadata, user: { id: '22' } })
    await assert.rejects(source.large('11', '12', signal()), /作者不匹配/)
    assert.equal(requests.length, 3)
  }
  const missing = new PixivAppSource({ accessToken: 'test-access' }, async () => Response.json({
    illust: work('12', { meta_single_page: { original_image_url: 'https://i.pximg.net/img-original/12_p0.png' } }),
  }))
  await assert.rejects(missing.large('11', '12', signal()), /没有可用的 large/)
  const unsafe = new PixivAppSource({ accessToken: 'test-access' }, async () => Response.json({
    illust: work('12', { image_urls: { large: 'https://evil.invalid/image.png' } }),
  }))
  await assert.rejects(unsafe.large('11', '12', signal()), /URL/)
})

test('live previews use list square_medium URLs and CDN only, without artwork detail requests', async () => {
  const requests: string[] = []
  const source = new PixivAppSource({ accessToken: 'test-access' }, async input => {
    const url = new URL(String(input))
    requests.push(url.href)
    if (url.hostname.endsWith('.pximg.net')) return new Response(png)
    assert.equal(url.pathname, '/v1/user/illusts')
    return url.searchParams.get('type') === 'manga' ? list() : list([work('12', {
      image_urls: { square_medium: 'https://i.pximg.net/square/12.png' },
    })])
  })
  const images = await source.latestImages('11', signal())
  assert.deepEqual(images, [{ id: '12', url: 'https://i.pximg.net/square/12.png' }])
  assert.deepEqual(await source.download(images[0]!.url, signal()), { body: png, extension: 'png' })
  assert.equal(requests.length, 3)
  await assert.rejects(source.download('https://example.invalid/image.png', signal()), /URL/)
  assert.equal(requests.length, 3)
})

test('429 pauses concurrent requests and retries once per minute until recovery', async t => {
  const waits: number[] = []
  let release!: () => void
  t.mock.method(timers, 'setTimeout', (milliseconds: number) => {
    waits.push(milliseconds)
    return new Promise<void>(resolve => { release = resolve })
  })
  const settle = () => new Promise<void>(resolve => setImmediate(resolve))
  const controller = new AbortController()
  let requests = 0
  const source = new PixivAppSource({ accessToken: 'test-access' }, async () => {
    requests++
    return requests <= 2 ? new Response('', { status: 429 }) : list()
  })
  const first = source.latest('11', controller.signal)
  await settle()
  assert.match(source.warning()!, /429/)
  assert.equal(source.retryStatus()!.attempts, 0)
  assert.ok(Math.abs(source.retryStatus()!.retryAt! - Date.now() - 60_000) < 1000)
  const second = source.latest('22', controller.signal)
  await settle()
  assert.equal(requests, 1)
  assert.deepEqual(waits, [60_000])
  release()
  await settle()
  assert.equal(requests, 2)
  assert.match(source.warning()!, /429/)
  assert.equal(source.retryStatus()!.attempts, 1)
  assert.ok(Math.abs(source.retryStatus()!.retryAt! - Date.now() - 60_000) < 1000)
  assert.deepEqual(waits, [60_000, 60_000])
  await settle()
  assert.equal(requests, 2)
  release()
  await Promise.all([first, second])
  assert.equal(requests, 6)
  assert.equal(source.warning(), null)
  assert.equal(source.retryStatus(), null)
})

test('429 waiting is abortable and clears the warning without sending another request', async () => {
  const controller = new AbortController()
  let requests = 0
  const source = new PixivAppSource({ accessToken: 'test-access' }, async () => {
    requests++
    return new Response('', { status: 429 })
  })
  const result = source.latest('11', controller.signal)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.match(source.warning()!, /429/)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(requests, 1)
  assert.equal(source.warning(), null)
  assert.equal(source.retryStatus(), null)
})

test('App API merges paginated illustrations and manga, keeps age-restricted IDs, and requests no webpage or iOS filter', async () => {
  const urls: URL[] = []
  const source = new PixivAppSource({ accessToken: 'test-access' }, async (input, options) => {
    const url = new URL(String(input)); urls.push(url)
    assert.equal(url.origin, 'https://app-api.pixiv.net')
    assert.equal(url.pathname, '/v1/user/illusts')
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-access')
    assert.equal(new Headers(options?.headers).get('cookie'), null)
    assert.equal(url.searchParams.get('filter'), '')
    if (url.searchParams.get('type') === 'manga') return list([work('9007199254740993', { x_restrict: 2 })])
    if (!url.searchParams.has('offset')) {
      return list([work('9007199254740992', { x_restrict: 1 })],
        'https://app-api.pixiv.net/v1/user/illusts?user_id=11&type=illust&offset=1&filter=')
    }
    return list(Array.from({ length: 10 }, (_, i) => work(String(10 - i))))
  })
  assert.deepEqual(await source.latest('11', signal()), ['9007199254740993', '9007199254740992', '10', '9', '8', '7', '6', '5', '4', '3'])
  assert.equal(urls.length, 3)
})

test('App API obtains OAuth tokens, refreshes once on 401, and never forwards auth credentials to the CDN', async () => {
  const requests: { url: string; options: RequestInit | undefined }[] = []
  let tokenRequests = 0, apiRequests = 0
  const source = new PixivAppSource({ ...auth, proxyUrl: 'http://127.0.0.1:7890' }, async (input, options) => {
    const url = String(input); requests.push({ url, options })
    assert.ok(options && 'dispatcher' in options && options.dispatcher instanceof ProxyAgent)
    const headers = new Headers(options.headers)
    assert.equal(headers.get('cookie'), null)
    if (url === 'https://oauth.secure.pixiv.net/auth/token') {
      tokenRequests++
      const body = new URLSearchParams(String(options.body))
      assert.equal(body.get('refresh_token'), tokenRequests === 1 ? 'test-refresh' : 'rotated-refresh')
      assert.equal(body.get('client_id'), auth.clientId)
      assert.equal(body.get('client_secret'), auth.clientSecret)
      assert.equal(headers.get('authorization'), null)
      return Response.json({ access_token: `access-${tokenRequests}`, refresh_token: 'rotated-refresh', expires_in: 3600 })
    }
    if (url.startsWith('https://app-api.pixiv.net/')) {
      if (++apiRequests === 1) return new Response('', { status: 401 })
      assert.equal(headers.get('authorization'), 'Bearer access-2')
      if (url.includes('/illust/detail')) return Response.json({ illust: work('12', {
        image_urls: { square_medium: 'https://i.pximg.net/square/12_p0.png' },
      }) })
      return list([])
    }
    assert.equal(url, 'https://i.pximg.net/square/12_p0.png')
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('referer'), 'https://www.pixiv.net/')
    return new Response(png)
  })
  try {
    assert.deepEqual(await source.latest('11', signal()), [])
    assert.deepEqual(await source.image('11', '12', signal()), { body: png, extension: 'png' })
    assert.equal(tokenRequests, 2)
    assert.equal(requests.filter(request => request.url.startsWith('https://www.pixiv.net')).length, 0)
  } finally { await source.close() }
})

test('single-page and multi-page works download only square_medium, never other sizes or originals', async () => {
  for (const fields of [
    { meta_pages: [], meta_single_page: { original_image_url: 'https://i.pximg.net/12_p0.png' } },
    { meta_pages: [{ image_urls: { original: 'https://i.pximg.net/12_p0.png' } }, { image_urls: { original: 'https://i.pximg.net/12_p1.png' } }] },
  ]) {
    const downloads: string[] = []
    const source = new PixivAppSource({ accessToken: 'test-access' }, async input => {
      if (String(input).startsWith('https://app-api.pixiv.net/')) return Response.json({ illust: work('12', {
        ...fields, image_urls: {
          square_medium: 'https://i.pximg.net/square/12_p0.png',
          medium: 'https://i.pximg.net/medium/12_p0.png',
          large: 'https://i.pximg.net/large/12_p0.png',
        },
      }) })
      downloads.push(String(input)); return new Response(png)
    })
    assert.deepEqual((await source.image('11', '12', signal())).body, png)
    assert.deepEqual(downloads, ['https://i.pximg.net/square/12_p0.png'])
  }
  for (const fields of [
    { user: { id: '22' } }, { id: '13' }, { is_visible: false },
    { image_urls: { square_medium: 'https://i.pximg.net.evil.invalid/12.png' } },
    { image_urls: { square_medium: 'http://i.pximg.net/12.png' } },
    { image_urls: { square_medium: 'https://127.0.0.1/12.png' } },
    { meta_single_page: { original_image_url: 'https://i.pximg.net/12_p0.png' } },
    { image_urls: { square_medium: null, medium: 'https://i.pximg.net/12_p0.png' } },
    { image_urls: { large: 'https://i.pximg.net/placeholder.png' } },
  ]) {
    let calls = 0
    const source = new PixivAppSource({ accessToken: 'test-access' }, async () => {
      calls++; return Response.json({ illust: work('12', fields) })
    })
    await assert.rejects(source.image('11', '12', signal()))
    assert.equal(calls, 1, 'Invalid images must fail before attempting download')
  }
})

test('App API fails closed on malformed/hidden lists and unsafe or repeated pagination', async () => {
  for (const response of [
    () => Response.json({}), () => list([work('12', { is_visible: false })]),
    () => list([work('12', { user: { id: '22' } })]), () => list([work('bad')]),
    () => list([], 'https://evil.invalid/v1/user/illusts?user_id=11&type=illust'),
    () => list([], 'https://app-api.pixiv.net/v1/user/illusts?user_id=22&type=illust'),
    () => list([], 'https://app-api.pixiv.net/v1/user/illusts?user_id=11&type=illust&filter=for_ios'),
    () => list([], 'https://app-api.pixiv.net/v1/user/illusts?user_id=11&type=illust&filter='),
  ]) {
    const source = new PixivAppSource({ accessToken: 'test-access' }, async () => response())
    await assert.rejects(source.latest('11', signal()))
  }
})

test('download safety limit rejects oversized bodies with or without content-length and cancels the stream', async () => {
  for (const contentLength of [undefined, String(21 * 1024 * 1024)]) {
    let cancelled = false
    const source = new PixivAppSource({ accessToken: 'test-access' }, async input => {
      if (String(input).startsWith('https://app-api.pixiv.net/')) return Response.json({ illust: work('12', {
        image_urls: { square_medium: 'https://i.pximg.net/square/12_p0.png' },
      }) })
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
        cancel() { cancelled = true },
      }), { headers: contentLength ? { 'Content-Length': contentLength } : {} })
    })
    await assert.rejects(source.image('11', '12', AbortSignal.timeout(30_000)), /20 MiB/)
    assert.equal(cancelled, true)
  }
})

test('OAuth credentials and failures are explicit, bounded and do not silently use anonymous API requests', async () => {
  for (const options of [{}, { refreshToken: 'r' }, { ...auth, clientSecret: '' }, { accessToken: 'bad\r\ntoken' }]) {
    let calls = 0
    const source = new PixivAppSource(options, async () => { calls++; return list() })
    await assert.rejects(source.latest('11', signal()), PixivAccessError)
    assert.equal(calls, 0)
  }
  for (const response of [
    () => new Response('', { status: 400 }),
    () => Response.json({ access_token: 'token-without-expiry' }),
    () => new Response('not json'),
  ]) {
    const source = new PixivAppSource(auth, async () => response())
    await assert.rejects(source.latest('11', signal()), PixivAccessError)
  }
  let calls = 0
  const denied = new PixivAppSource({ ...auth, accessToken: 'expired' }, async input => {
    calls++
    return String(input).includes('/auth/token')
      ? Response.json({ response: { access_token: 'still-denied', expires_in: 3600 } })
      : new Response('', { status: 401 })
  })

  await assert.rejects(denied.latest('11', signal()), PixivAccessError)
  assert.equal(calls, 3, 'Only one refresh and one retry should be attempted')
  for (const response of [
    () => new Response('', { status: 401 }), () => new Response('', { status: 403 }),
    () => new Response('', { status: 302, headers: { Location: 'https://www.pixiv.net/' } }),
    () => new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    () => new Response('not json'),
  ]) {
    const source = new PixivAppSource({ accessToken: 'test-access' }, async () => response())
    await assert.rejects(source.latest('11', signal()), PixivAccessError)
  }
})

test('parallel 401 responses share one token refresh even when a stale response arrives after refresh completes', async () => {
  let release!: () => void, bothStarted!: () => void, refreshed!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { bothStarted = resolve })
  const refreshComplete = new Promise<void>(resolve => { refreshed = resolve })
  let oldRequests = 0, tokenRequests = 0
  const source = new PixivAppSource({ ...auth, accessToken: 'old-token' }, async (input, options) => {
    if (String(input).includes('/auth/token')) {
      tokenRequests++
      return Response.json({ access_token: 'new-token', expires_in: 3600 })
    }
    const token = new Headers(options?.headers).get('authorization')
    if (token === 'Bearer old-token') {
      oldRequests++
      if (oldRequests === 2) { bothStarted(); await gate }
      return new Response('', { status: 401 })
    }
    assert.equal(token, 'Bearer new-token')
    refreshed()
    return list()
  })
  const first = source.latest('11', signal()), second = source.latest('22', signal())
  try {
    await started
    await refreshComplete
  } finally { release() }
  await Promise.all([first, second])
  assert.equal(tokenRequests, 1)
})
