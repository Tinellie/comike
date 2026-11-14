import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { tokenHash } from '../src/auth/routes.js'
import { LoginRequiredError } from '../src/crawler/parser.js'
import { normalizeColour, parseFavorites } from '../src/favorites/parser.js'
import { FavoritesService, ImportConflictError } from '../src/favorites/service.js'
import { MemoryAuthStore } from './authFixture.js'
import { FakeImportLogin, favoriteHtml, MemoryFavoritesStore } from './favoritesFixture.js'

async function settled(service: FavoritesService, userId: string) {
  const deadline = Date.now() + 5000
  for (;;) {
    const status = await service.status(userId)
    if (['succeeded', 'failed', 'cancelled'].includes(status.status)) return status
    if (Date.now() > deadline) throw new Error('Import did not settle')
    await delay(5)
  }
}

test('real rendered favorites fixture: page count, named-circle IDs, CSS colours, memos and duplicate document snapshots', async () => {
  const html = await readFile(new URL('../../ref/favourite-list.html', import.meta.url), 'utf8')
  const result = parseFavorites(html, 2)
  assert.equal(result.pages, 2)
  assert.equal(result.total, 170)
  assert.equal(result.entries.length, 70)
  assert.equal(result.entries[0]?.boothId, '24019260')
  assert.equal(result.entries[0]?.colour, '#FFF700')
  assert.ok(result.entries[0]?.memo.length)
  assert.ok(result.entries.every(entry => /^\d+$/.test(entry.boothId) && /^#[\dA-F]{6}$/.test(entry.colour)))
  assert.equal(new Set(result.entries.map(entry => entry.boothId)).size, 70)
})

test('favorites parser handles one page, empty lists, rendered/inline colour overrides, entities and multiline memos', () => {
  assert.equal(parseFavorites(favoriteHtml(1, 1), 1).pages, 1)
  assert.deepEqual(parseFavorites(favoriteHtml(1, 0), 1).entries, [])
  const html = favoriteHtml(1, 1)
    .replace('class="favorite-color favorite-color-3"', 'class="favorite-color favorite-color-3" data-import-colour="rgb(0, 181, 74)"')
    .replace('memo 24000000', 'first &amp; second<br>次の行')
  assert.deepEqual(parseFavorites(html, 1).entries, [{
    boothId: '24000000', colour: '#00B54A', memo: 'first & second\n次の行',
  }])
  assert.equal(parseFavorites(favoriteHtml(1, 1).replace('rowspan="3"', 'rowspan="3" style="background-color:#f00"'), 1).entries[0]?.colour, '#FF0000')
  for (const [value, expected] of [['#abc', '#AABBCC'], ['rgb(255, 0, 74)', '#FF004A']]) {
    assert.equal(normalizeColour(value!), expected)
  }
  for (const value of ['transparent', 'rgb(256,0,0)', 'red', '#12345', 'url(evil)']) assert.throws(() => normalizeColour(value))
})

test('malformed, incomplete or incorrect favorites pages fail instead of overwriting old data', () => {
  const html = favoriteHtml(1, 101)
  for (const broken of [
    html.replace('101 件中', 'Unknown'),
    html.replace('page=2', 'page=3'),
    html.replace('count=100', 'count=20'),
    html.replace('/User/Favorites?count', 'https://other.invalid/User/Favorites?count'),
    html.replace('memo 24000000', 'x'.repeat(2049)),
    html.replace('class="infotable-circlename"', 'class="unknown"'),
    html.replace('href="/Circle/24000000"', 'href="https://other.invalid/Circle/24000000"'),
    html.replace('/Circle/24000001', '/Circle/24000000'),
    html.replace('text: favMemo()', 'text: unknown()'),
    html.replace('favorite-color-3" rowspan', 'favorite-color-99" rowspan'),
  ]) assert.throws(() => parseFavorites(broken, 1))
  assert.throws(() => parseFavorites(html, 2), /错误页/)
  assert.throws(() => parseFavorites('<input type="password">', 1), LoginRequiredError)
  assert.throws(() => parseFavorites('<div>Unavailable</div>', 1), /结构缺失/)
})

test('per-user jobs replace only their own data after successful logout; failures, stops and timeouts preserve records', async t => {
  const store = new MemoryFavoritesStore()
  const old = [{ boothId: '1', colour: '#000000', memo: 'keep' }]
  store.records.set('a', old); store.records.set('b', old)
  const logins: FakeImportLogin[] = []
  const events: string[] = []
  const service = new FavoritesService(store, () => {
    const login = new FakeImportLogin()
    const logout = login.logout.bind(login)
    login.logout = async () => { events.push('logout'); await logout() }
    logins.push(login)
    return login
  }, async (_login, signal, progress) => {
    signal.throwIfAborted()
    progress(1, 1, 1)
    return [{ boothId: '2', colour: '#FFF700', memo: 'new' }]
  })
  const replace = store.replace.bind(store)
  store.replace = async (id, entries) => { events.push('save'); await replace(id, entries) }
  t.after(() => service.close())
  service.start('a')
  assert.throws(() => service.start('a'), ImportConflictError)
  await service.confirmLogin('a')
  assert.equal((await settled(service, 'a')).status, 'succeeded')
  assert.deepEqual(events, ['logout', 'save'])
  assert.equal(logins[0]?.cleared, 1)
  assert.deepEqual(store.records.get('b'), old)
  assert.deepEqual(store.records.get('a')?.map(entry => entry.boothId), ['2'])
  assert.equal((await service.status('b')).status, 'idle')
  assert.equal((await service.status('b')).login.open, false)
  service.start('b')
  service.stop('b')
  assert.equal((await settled(service, 'b')).status, 'cancelled')
  assert.deepEqual(store.records.get('b'), old)
  assert.equal(logins[1]?.logouts, 1)
  assert.equal(logins[1]?.cleared, 1)

  for (const kind of ['crawl', 'logout', 'save', 'timeout'] as const) {
    const login = new FakeImportLogin()
    const failingStore = new MemoryFavoritesStore()
    failingStore.records.set('user', old)
    if (kind === 'logout') login.logout = async () => { login.logouts++; throw new Error('logout unavailable') }
    if (kind === 'save') failingStore.replace = async () => { throw new Error('transaction unavailable') }
    const failing = new FavoritesService(failingStore, () => login, async () => {
      if (kind === 'crawl') throw new Error('page failed')
      return []
    }, kind === 'timeout' ? 50 : 5000)
    t.after(() => failing.close())
    failing.start('user')
    if (kind !== 'timeout') await failing.confirmLogin('user')
    const status = await settled(failing, 'user')
    assert.notEqual(status.status, 'succeeded')
    assert.ok(status.message)
    assert.equal(login.logouts, 1)
    assert.equal(login.cleared, 1)
    assert.deepEqual(failingStore.records.get('user'), old)
  }
})

test('expired Circle.ms login restarts from page one; empty results clear favorites; shutdown logs out waiting jobs', async () => {
  const store = new MemoryFavoritesStore()
  store.records.set('a', [{ boothId: '1', colour: '#000000', memo: '' }])
  const login = new FakeImportLogin()
  let attempts = 0
  const service = new FavoritesService(store, () => login, async () => {
    attempts++
    if (attempts === 1) throw new LoginRequiredError()
    return []
  })
  service.start('a')
  await service.confirmLogin('a')
  const deadline = Date.now() + 5000
  while (attempts < 1 || login.authenticated) {
    if (Date.now() > deadline) throw new Error('Login expiry not processed')
    await delay(5)
  }
  assert.equal((await service.status('a')).status, 'waiting_login')
  await service.confirmLogin('a')
  assert.equal((await settled(service, 'a')).status, 'succeeded')
  assert.deepEqual(store.records.get('a'), [])
  assert.equal(attempts, 2)
  service.start('b')
  await service.close()
  assert.equal((await service.status('b')).status, 'cancelled')
  assert.equal(login.logouts, 2)
  assert.equal(login.cleared, 2)
})

test('import browser capacity is bounded and does not create extra sessions on rejected starts', async () => {
  const logins: FakeImportLogin[] = []
  const service = new FavoritesService(new MemoryFavoritesStore(), () => {
    const login = new FakeImportLogin(); logins.push(login); return login
  })
  for (const id of ['a', 'b', 'c', 'd']) service.start(id)
  assert.throws(() => service.start('e'), /人数较多/)
  assert.equal(logins.length, 4)
  await service.close()
  assert.ok(logins.every(login => login.logouts === 1 && login.cleared === 1))
  assert.throws(() => service.start('e'), /正在关闭/)
})

test('stopping an in-flight browser read reports cancellation, logs out and preserves data', async t => {
  const store = new MemoryFavoritesStore()
  const old = [{ boothId: 'old', colour: '#000000', memo: '' }]
  store.records.set('user', old)
  const login = new FakeImportLogin()
  let markReading: () => void = () => {}
  const reading = new Promise<void>(resolve => { markReading = resolve })
  const service = new FavoritesService(store, () => login, async (_login, signal) => {
    markReading()
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Target page has been closed')), { once: true })
    })
  })
  t.after(() => service.close())
  service.start('user')
  await service.confirmLogin('user')
  await reading
  service.stop('user')
  const status = await settled(service, 'user')
  assert.equal(status.status, 'cancelled')
  assert.match(status.message!, /已停止/)
  assert.equal(login.logouts, 1)
  assert.equal(login.cleared, 1)
  assert.deepEqual(store.records.get('user'), old)
})

test('ordinary authenticated users can import; sessions, inputs, screenshots and records never cross users', async t => {
  const auth = new MemoryAuthStore()
  const store = new MemoryFavoritesStore()
  const logins: FakeImportLogin[] = []
  const service = new FavoritesService(store, () => {
    const login = new FakeImportLogin(); logins.push(login); return login
  }, async () => [{ boothId: '10', colour: '#FF0000', memo: '' }])
  for (const [name, token] of [['a', 'a'.repeat(64)], ['b', 'b'.repeat(64)]]) {
    auth.users.set(name!, { id: name!, username: name!, isAdmin: false, passwordHash: '' })
    await auth.createSession(tokenHash(token!), name!, new Date(Date.now() + 60_000))
  }
  const server = createApp({ checkDatabase: async () => {}, authStore: auth, favorites: service }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await service.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/import`
  const request = (path: string, user?: 'a' | 'b', body?: unknown, extra: Record<string, string> = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { Cookie: `comike_session=${user.repeat(64)}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  for (const [path, body] of [['/status', undefined], ['/start', {}], ['/stop', {}],
    ['/login/screenshot', undefined], ['/login/input', { type: 'text', text: 'private' }], ['/login/confirm', {}]]) {
    assert.equal((await request(String(path), undefined, body)).status, 401)
  }
  assert.equal((await request('/start', 'a', {}, { Origin: 'https://evil.invalid' })).status, 403)
  assert.equal((await request('/status', 'a', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await request('/start', 'a', { userId: 'b' })).status, 202)
  assert.equal((await request('/start', 'a', {})).status, 409)
  assert.equal((await request('/status', 'b')).status, 200)
  assert.equal((await (await request('/status', 'b')).json()).status, 'idle')
  assert.equal((await request('/login/screenshot', 'b')).status, 409)
  assert.equal((await request('/login/input', 'b', { type: 'text', text: 'private' })).status, 409)
  assert.equal((await request('/login/input', 'a', { type: 'click', x: -1, y: 0 })).status, 400)
  assert.equal((await request('/login/input', 'a', { type: 'text', text: 'own credentials', userId: 'b' })).status, 204)
  assert.equal(logins[0]?.received.length, 1)
  assert.equal((await request('/login/screenshot', 'a')).headers.get('cache-control'), 'no-store')
  assert.equal((await request('/start', 'b', {})).status, 202)
  assert.equal((await request('/login/confirm', 'a', {})).status, 200)
  assert.equal((await settled(service, 'a')).status, 'succeeded')
  assert.equal((await service.status('b')).status, 'waiting_login')
  assert.equal(logins[1]?.authenticated, false)
  assert.equal(store.records.has('b'), false)
  assert.equal((await request('/stop', 'b', {})).status, 202)
  assert.equal((await settled(service, 'b')).status, 'cancelled')
  const status = await (await request('/status', 'a')).json()
  assert.equal(status.savedCount, 1)
  assert.equal('userId' in status, false)
  assert.equal('internal_id' in status, false)
})
