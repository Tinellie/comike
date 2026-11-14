import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { imageExtension, listStoredBoothImages, saveImage } from '../src/crawler/images.js'
import { isLoginPage, LoginRequiredError, parseDetail, parseLocation } from '../src/crawler/parser.js'
import { parseBrowserInput } from '../src/crawler/routes.js'
import { CrawlerService } from '../src/crawler/service.js'
import type { LoginSession } from '../src/crawler/login.js'
import type { CircleListCache, CrawlJob, JobRepository } from '../src/crawler/types.js'
import type { Booth } from '../src/db/schema.js'

const fixture = await readFile(new URL('../../ref/circle-detail.html', import.meta.url), 'utf8')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=', 'base64')

test('real detail fixture: IDs, hashtag edition, single weekday and all type-2 cuts renamed for the current record', () => {
  const { booth, images } = parseDetail(fixture, '24031654')
  assert.equal(booth.id, '24031654')
  assert.equal(booth.event_id, '240')
  assert.equal(booth.comiket, 109)
  assert.equal(booth.circle_name, 'いもむすめ。')
  assert.equal(booth.author_name, '荻pote')
  assert.equal(booth.weekday, '火')
  assert.equal(booth.hall, '東')
  assert.equal(booth.island_code, 'ア')
  assert.equal(booth.booth_number, '04')
  assert.equal(booth.booth_suffix, 'ab')
  assert.equal(booth.genre, 'ブルーアーカイブ')
  assert.equal(booth.genre_code, '336')
  assert.equal(booth.circle_id, '10091582')
  assert.equal(booth.pixiv_id, '2131660')
  assert.equal(booth.twitter_id, 'ogipote')
  assert.equal(booth.circle_appeal, 'サークル名を変更いたしました！頒布物や内容の傾向は変化ございません！\n(旧Milky Been!)\nアニメ塗りを基調としたイラスト集や様々なグッズを作っております。')
  assert.equal(booth.tags, null)
  assert.equal('location' in booth, false)
  assert.equal(booth.images, '[]')
  assert.deepEqual(images.map(image => image.stem), ['24031654_1', '24031654_2'])
  assert.deepEqual(images.map(image => new URL(image.url).pathname.split('/').slice(0, 5).join('/')), [
    '/Spa/CachedImage/24031653/2', '/Spa/CachedImage/24031654/2',
  ])
})

test('appeal and tags retain plain multiline text, decode entities and discard scripts and styles', () => {
  const html = fixture
    .replace(/(<th>タグ<\/th>\s*<td\b[^>]*>)[\s\S]*?(<\/td>)/, '$1<a href="/tag/1">創作 &amp; 漫画</a><a href="/tag/2">イラスト</a><br>全年齢<script>ignored()</script><style>.ignored{}</style>$2')
    .replace(/(<th>補足説明\/サークルアピール<\/th>\s*<td\b[^>]*>)[\s\S]*?(<\/td>)/, '$1<p>第一段落 &amp; 説明</p><p>第二段落<br>続き</p><script>ignored()</script>$2')
  const { booth } = parseDetail(html, '24031654')
  assert.equal(booth.circle_appeal, '第一段落 & 説明\n\n第二段落\n続き')
  assert.equal(booth.tags, '創作 & 漫画\nイラスト\n\n全年齢')
  assert.equal(booth.circle_appeal?.includes('<'), false)
  assert.equal(booth.tags?.includes('ignored'), false)
})

test('empty appeal and tags save null; long text is not truncated and missing field labels are explicit errors', () => {
  const empty = fixture.replace(/(<th>補足説明\/サークルアピール<\/th>\s*<td\b[^>]*>)[\s\S]*?(<\/td>)/, '$1 <br> $2')
  assert.equal(parseDetail(empty, '24031654').booth.circle_appeal, null)
  assert.equal(parseDetail(empty, '24031654').booth.tags, null)
  const longText = '長文'.repeat(40_000)
  const html = empty.replace(/(<th>タグ<\/th>\s*<td\b[^>]*>)[\s\S]*?(<\/td>)/, `$1${longText}$2`)
    .replace(/(<th>補足説明\/サークルアピール<\/th>\s*<td\b[^>]*>)[\s\S]*?(<\/td>)/, `$1${longText}$2`)
  const { booth } = parseDetail(html, '24031654')
  assert.equal(booth.circle_appeal, longText)
  assert.equal(booth.tags, longText)
  assert.throws(() => parseDetail(fixture.replace('<th>タグ</th>', '<th>Unknown</th>'), '24031654'), /详情缺少字段：タグ/)
})

test('detail without a circle homepage ID is valid and saves null', () => {
  const html = fixture.replaceAll('/Circle/Index/10091582', '/unregistered')
  const { booth, images } = parseDetail(html, '24031654')
  assert.equal(booth.circle_id, null)
  assert.equal(booth.circle_name, 'いもむすめ。')
  assert.deepEqual(images.map(image => image.stem), ['24031654_1', '24031654_2'])
})

test('missing type-2 images produce an empty array, never a type-1 fallback', () => {
  const html = fixture.replace(/(\/CachedImage\/\d+\/)2\//g, '$11/')
  assert.deepEqual(parseDetail(html, '24031654').images, [])
})

test('image sequence follows DOM order past nine, deduplicates URLs and ignores unrelated image types and hosts', () => {
  const urls = Array.from({ length: 12 }, (_, index) => `/Spa/CachedImage/123/2/image-${index}`)
  const additional = [...urls, urls[0], '/Spa/CachedImage/123/1/ignored', 'https://unrelated.example/Spa/CachedImage/123/2/ignored']
    .map(url => `<img src="${url}">`).join('')
  const html = fixture.replace('<div class="m-circletable-cuts">', `<div class="m-circletable-cuts">${additional}`)
  const { images } = parseDetail(html, '24031654')
  assert.equal(images.length, 14)
  assert.deepEqual(images.map(image => image.stem), Array.from({ length: 14 }, (_, index) => `24031654_${index + 1}`))
  assert.deepEqual(images.slice(0, 12).map(image => new URL(image.url).pathname), urls)
})

test('detail parser explicitly rejects wrong IDs, missing edition and login HTML', () => {
  assert.throws(() => parseDetail(fixture, '24031653'), /ID/)
  assert.throws(() => parseDetail(fixture.replaceAll('C109WebCatalog', 'unknown'), '24031654'), /hashtag/)
  assert.throws(() => parseDetail('<input type="password">', '24031654'), LoginRequiredError)
  assert.equal(isLoginPage('https://classic-webcatalog.circle.ms/Account/Login?ReturnUrl=/Spa', ''), true)
  assert.throws(() => parseLocation('unknown'), /配置/)
  assert.deepEqual(parseLocation('水曜日 西Ａ０１b'), {
    weekday: '水', hall: '西', island_code: 'A', booth_number: '01', booth_suffix: 'b',
  })

})

test('static HTML edition is read before Twitter replaces the share button with an iframe', () => {
  const staticHtml = fixture.replace(/<iframe\b[^>]*twitter-share-button[^>]*><\/iframe>/, '<a href="https://twitter.com/share" data-hashtags="C109WebCatalog">Share</a>')
  assert.equal(staticHtml.includes('hashtags=C109WebCatalog'), false)
  assert.equal(parseDetail(staticHtml, '24031654').booth.comiket, 109)
})

test('images use content signatures, not a forced png extension', () => {
  assert.equal(imageExtension(png), 'png')
  assert.equal(imageExtension(Buffer.from([255, 216, 255, 0])), 'jpg')
  assert.equal(imageExtension(Buffer.from('GIF89a')), 'gif')
  assert.equal(imageExtension(Buffer.from('RIFF0000WEBP')), 'webp')
  assert.throws(() => imageExtension(Buffer.from('<html>login</html>')), /图片/)
})

test('image storage is flat by edition, filename array is a JSON string; login HTML never becomes an image', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-crawler-images-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(png, {
    headers: { 'Content-Type': 'image/png' },
  }))
  const image = { url: 'https://classic-webcatalog.circle.ms/Spa/CachedImage/24031653/2/test', stem: '24031654_1' }
  const session = { cookieHeader: async () => 'session=test' }
  const name = await saveImage(image, 109, directory, session, new AbortController().signal)
  assert.equal(name, '24031654_1.png')
  assert.deepEqual(await readFile(join(directory, 'booths', 'c109', name)), png)
  assert.equal(JSON.stringify([name]), '["24031654_1.png"]')
  await assert.rejects(saveImage({ ...image, url: image.url.replace('/2/', '/1/') }, 109, directory, session, new AbortController().signal), /outside/)
  for (const stem of ['24031654_0', '24031654_01', '24031654_-1']) {
    await assert.rejects(saveImage({ ...image, stem }, 109, directory, session, new AbortController().signal), /storage key/)
  }
  assert.equal(await saveImage({ ...image, stem: '24031654_10' }, 109, directory, session, new AbortController().signal), '24031654_10.png')
  assert.deepEqual(await readFile(join(directory, 'booths', 'c109', '24031654_10.png')), png)
  fetchMock.mock.mockImplementation(async () => new Response('<input type="password">', {
    headers: { 'Content-Type': 'text/html' },
  }))
  await assert.rejects(saveImage(image, 109, directory, session, new AbortController().signal), LoginRequiredError)
  await assert.rejects(saveImage({ ...image, stem: '../evil' }, 109, directory, session, new AbortController().signal), /storage key/)
})

function fakeLogin(): LoginSession {
  let open = false
  let authenticated = false
  return {
    generation: 0,
    status: () => ({ open, authenticated, width: 1280, height: 800 }),
    open: async () => { open = true },
    confirm: async () => { authenticated = true; open = false },
    invalidate: () => { authenticated = false },
    waitForLogin: async signal => {
      open = true
      signal.throwIfAborted()
      if (authenticated) return
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    storageState: async () => ({ cookies: [], origins: [] }),
    cookieHeader: async () => '',
    screenshot: async () => png,
    input: async () => {},
    clear: async () => { open = false; authenticated = false },
    close: async () => {},
  }
}

test('image redirects follow allowed storage without forwarding catalog cookies to Azure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-image-redirect-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls: { url: string; cookie: string | null }[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input)
    calls.push({ url, cookie: new Headers(options?.headers).get('cookie') })
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { Location: 'https://webcatalogj07.blob.core.windows.net/cuts/123.png' } })
    }
    return new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } })
  })
  const name = await saveImage({
    url: 'https://classic-webcatalog.circle.ms/Spa/CachedImage/123/2/test', stem: '123_2',
  }, 109, directory, { cookieHeader: async () => 'catalog_session=private' }, new AbortController().signal)
  assert.equal(name, '123_2.png')
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.cookie, 'catalog_session=private')
  assert.equal(calls[1]?.cookie, null)
})

test('image login redirects and unsupported hosts have distinct explicit failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-image-redirect-rejected-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302, headers: { Location: '/Account/Login' },
  }))
  const image = { url: 'https://classic-webcatalog.circle.ms/Spa/CachedImage/123/2/test', stem: '123_2' }
  const login = { cookieHeader: async () => '' }
  await assert.rejects(saveImage(image, 109, directory, login, new AbortController().signal), LoginRequiredError)
  mocked.mock.mockImplementation(async () => new Response(null, {
    status: 302, headers: { Location: 'https://unrelated.example/image.png' },
  }))
  await assert.rejects(saveImage(image, 109, directory, login, new AbortController().signal), /不受支持/)
})

class MemoryRepository implements JobRepository {
  job: CrawlJob | null = null
  records: Booth[] = []
  cache: CircleListCache | null = null
  async check() {}
  async load() { return this.job ? structuredClone(this.job) : null }
  async save(job: CrawlJob) { this.job = structuredClone(job) }
  async saveBooth(booth: Booth) { this.records.push(booth) }
  async loadList() { return this.cache ? structuredClone(this.cache) : null }
  async saveList(cache: CircleListCache) { this.cache = structuredClone(cache) }
  async resetRecords() {
    const count = this.records.length
    this.records = []
    this.job = null
    return count
  }
  async savedBooths(ids: string[]) {
    const saved = this.records.filter(booth => ids.includes(booth.id))
    return { records: saved, sample: saved[0] ?? null }
  }
}

test('simultaneous start requests reserve a single task before database preparation finishes', async () => {
  const repository = new MemoryRepository()
  const service = new CrawlerService(fakeLogin(), repository, tmpdir(), tmpdir())
  try {
    const results = await Promise.allSettled([service.start(), service.start()])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.match(rejected.reason.message, /正在运行/)
    assert.equal(service.active, true)
  } finally { await service.close() }
  assert.equal(service.active, false)
})

test('crawler API: status, remote controls, initialization, conflicts, stop and persistent recovery', async t => {
  const repository = new MemoryRepository()
  const login = fakeLogin()
  const service = new CrawlerService(login, repository, tmpdir(), tmpdir())
  let initialized = false
  const app = createApp({
    checkDatabase: async () => {},
    crawler: service,
    initializeDatabase: async () => { initialized = true },
    hallEditorOrigin: 'http://localhost:5173',
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await service.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/crawler`
  const post = (path: string, body: unknown = {}) => fetch(`${base}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await fetch(`${base}/status`)).status, 200)
  const unopened = await fetch(`${base}/login/screenshot`)
  assert.equal(unopened.status, 409)
  assert.equal((await unopened.json()).authenticated, false)
  const normalStatus = login.status.bind(login)
  const errorStatus = t.mock.method(login, 'status', () => ({ ...normalStatus(), error: 'Login site unavailable' }))
  const failedOpening = await fetch(`${base}/login/screenshot`)
  assert.equal(failedOpening.status, 409)
  assert.equal((await failedOpening.json()).message, 'Login site unavailable')
  errorStatus.mock.restore()
  const openingStatus = t.mock.method(login, 'status', () => ({ ...normalStatus(), opening: true }))
  assert.equal((await fetch(`${base}/login/screenshot`)).status, 202)
  openingStatus.mock.restore()
  assert.equal((await post('initialize')).status, 200)
  assert.equal(initialized, true)
  assert.equal((await post('start', { resume: 'yes' })).status, 400)
  assert.equal((await post('start', { refreshList: 'yes' })).status, 400)
  assert.equal((await post('start', { resume: true, refreshList: true })).status, 409)
  assert.equal((await post('start')).status, 202)
  assert.equal((await post('start')).status, 409)
  assert.equal((await post('reset', { confirmation: '清空' })).status, 409)
  assert.equal((await post('login/clear')).status, 409)
  assert.equal((await post('login/input', { type: 'click', x: -1, y: 0 })).status, 400)
  assert.equal((await post('login/input', { type: 'key', key: 'Control+a' })).status, 204)
  const screenshot = await fetch(`${base}/login/screenshot`)
  assert.equal(screenshot.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), png)
  const crossOrigin = await fetch(`${base}/login/screenshot`, { headers: { Origin: 'https://evil.example' } })
  assert.equal(crossOrigin.status, 403)
  assert.equal((await post('stop')).status, 202)
  await service.close()
  assert.equal((await service.status()).status, 'interrupted')
  assert.equal(repository.job?.status, 'interrupted')
  await login.confirm()
  const alreadyLoggedIn = await fetch(`${base}/login/screenshot`)
  assert.equal(alreadyLoggedIn.status, 409)
  assert.equal((await alreadyLoggedIn.json()).authenticated, true)
  await login.open()
  t.mock.method(login, 'screenshot', async () => {
    await login.confirm()
    throw new Error('Page closed during screenshot')
  })
  const closedDuringCapture = await fetch(`${base}/login/screenshot`)
  assert.equal(closedDuringCapture.status, 409)
  assert.equal((await closedDuringCapture.json()).authenticated, true)
  const recovered = new CrawlerService(fakeLogin(), repository, tmpdir(), tmpdir())
  assert.equal((await recovered.status()).id, repository.job?.id)
  assert.equal((await recovered.status()).status, 'interrupted')
})

test('reset API requires confirmation, excludes concurrent starts and preserves cache, login and other resources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-reset-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const media = join(directory, 'media')
  const edition = join(media, 'booths', 'c109')
  const privateDirectory = join(directory, 'private')
  await mkdir(edition, { recursive: true })
  await mkdir(privateDirectory)
  await writeFile(join(edition, '24031654_1.png'), png)
  await writeFile(join(edition, '24031654_12.webp'), 'old image')
  await writeFile(join(edition, '24031654_2.png.00000000-0000-0000-0000-000000000000.tmp'), 'partial download')
  await writeFile(join(media, 'map.png'), 'keep other media')
  await writeFile(join(privateDirectory, 'auth.json'), 'keep login state')
  const repository = new MemoryRepository()
  repository.records = [parseDetail(fixture, '24031654').booth]
  repository.cache = { ids: ['24031654'], eventId: '240', comiket: 109, completedAt: new Date().toISOString() }
  repository.job = {
    id: 'old-job', status: 'completed', action: 'Completed',
    ids: ['24031654'], completedIds: ['24031654'], failures: {}, listComplete: true,
    eventId: '240', comiket: 109, sample: repository.records[0]!,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const login = fakeLogin()
  await login.confirm()
  const service = new CrawlerService(login, repository, media, privateDirectory)
  const app = createApp({ checkDatabase: async () => {}, crawler: service, initializeDatabase: async () => {} })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await service.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/crawler`
  const post = (path: string, body: unknown) => fetch(`${base}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await post('reset', {})).status, 400)
  assert.equal((await post('reset', { confirmation: true })).status, 400)
  assert.equal((await fetch(`${base}/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
    body: JSON.stringify({ confirmation: '清空' }),
  })).status, 403)
  let markStarted: () => void = () => {}
  let release: () => void = () => {}
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const reset = repository.resetRecords.bind(repository)
  t.mock.method(repository, 'resetRecords', async () => { markStarted(); await gate; return reset() })
  const request = post('reset', { confirmation: '清空' })
  await started
  try {
    assert.equal((await service.status()).status, 'resetting')
    assert.equal((await post('start', {})).status, 409)
    assert.equal((await post('reset', { confirmation: '清空' })).status, 409)
    assert.equal((await post('login/clear', {})).status, 409)
  } finally { release() }
  const response = await request
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.deletedBooths, 1)
  assert.equal(result.deletedImages, 3)
  assert.deepEqual(await readdir(edition), [])
  assert.equal(await readFile(join(media, 'map.png'), 'utf8'), 'keep other media')
  assert.equal(await readFile(join(privateDirectory, 'auth.json'), 'utf8'), 'keep login state')
  const status = await service.status()
  assert.equal(status.id, null)
  assert.equal(status.status, 'idle')
  assert.equal(status.succeeded, 0)
  assert.equal(status.sample, null)
  assert.equal(status.listCache?.total, 1)
  assert.equal(status.login.authenticated, true)
  const restored = new CrawlerService(login, repository, media, privateDirectory)
  assert.equal((await restored.status()).id, null)
  assert.equal((await restored.status()).listCache?.total, 1)
  assert.equal((await post('reset', { confirmation: '清空' })).status, 200)
})

test('reset refuses unknown files and directory links before changing database records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-reset-refused-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const media = join(directory, 'media')
  const edition = join(media, 'booths', 'c109')
  await mkdir(edition, { recursive: true })
  await writeFile(join(edition, 'notes.txt'), 'not a crawler image')
  const repository = new MemoryRepository()
  repository.records = [parseDetail(fixture, '24031654').booth]
  const service = new CrawlerService(fakeLogin(), repository, media, directory)
  t.after(() => service.close())
  await assert.rejects(service.reset(), /未知文件/)
  assert.equal(repository.records.length, 1)
  assert.equal(service.active, false)
  await rm(join(edition, 'notes.txt'))
  const outside = join(directory, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, '123_1.png'), png)
  await symlink(outside, join(media, 'booths', 'c110'), 'junction')
  await assert.rejects(service.reset(), /符号链接/)
  assert.equal(repository.records.length, 1)
  assert.deepEqual(await readFile(join(outside, '123_1.png')), png)
  const missingMedia = join(directory, 'missing')
  assert.deepEqual(await listStoredBoothImages(missingMedia), [])
})

test('reset reports database failures without deleting images and releases its reservation for retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-reset-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const edition = join(directory, 'booths', 'c109')
  await mkdir(edition, { recursive: true })
  await writeFile(join(edition, '123_1.png'), png)
  const repository = new MemoryRepository()
  const service = new CrawlerService(fakeLogin(), repository, directory, directory)
  t.after(() => service.close())
  const reset = t.mock.method(repository, 'resetRecords', async () => { throw new Error('Database write denied') })
  await assert.rejects(service.reset(), /Database write denied/)
  assert.deepEqual(await readdir(edition), ['123_1.png'])
  assert.equal(service.active, false)
  reset.mock.restore()
  assert.equal((await service.reset()).deletedImages, 1)
})

test('input validation allows bounded mouse, keys, wheel and text but rejects arbitrary controls', () => {
  assert.deepEqual(parseBrowserInput({ type: 'click', x: 1279, y: 799 }), { type: 'click', x: 1279, y: 799 })
  assert.throws(() => parseBrowserInput({ type: 'click', x: 1280, y: 0 }))
  assert.throws(() => parseBrowserInput({ type: 'key', key: 'F12' }))
  assert.throws(() => parseBrowserInput({ type: 'text', text: 'a'.repeat(2049) }))
  assert.throws(() => parseBrowserInput({ type: 'wheel', deltaY: Infinity }))
})
