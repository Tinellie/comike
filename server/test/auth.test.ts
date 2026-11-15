import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { tokenHash } from '../src/auth/routes.js'
import { hashPassword, verifyPassword } from '../src/auth/password.js'
import { MemoryAuthStore } from './authFixture.js'

test('passwords use distinct salted hashes and reject wrong passwords', async () => {
  const first = await hashPassword('correct-password')
  const second = await hashPassword('correct-password')
  assert.notEqual(first, second)
  assert.equal(first.includes('correct-password'), false)
  assert.equal(await verifyPassword('correct-password', first), true)
  assert.equal(await verifyPassword('wrong-password', first), false)
  await assert.rejects(verifyPassword('password', 'invalid'), /Invalid stored/)
})

for (const trustProxy of [false, true]) {
  test(`login limits ${trustProxy ? 'trust only the nearest proxy address' : 'ignore untrusted forwarded addresses'}`, async t => {
    const server = createApp({ checkDatabase: async () => {}, trustProxy }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`
    const login = (forwarded: string) => fetch(url, { method: 'POST', headers: { 'X-Forwarded-For': forwarded } })
    for (let index = 0; index < 20; index++) {
      assert.equal((await login('203.0.113.99, 203.0.113.1')).status, 400)
    }
    assert.equal((await login('203.0.113.98, 203.0.113.1')).status, 429)
    assert.equal((await login('203.0.113.99, 203.0.113.2')).status, trustProxy ? 400 : 429)
  })
}

test('registration, login, session rotation, permissions, revocation and expiry', async t => {
  const store = new MemoryAuthStore()
  let regenerations = 0
  const options = {
    checkDatabase: async () => {}, authStore: store, secureCookie: true,
    regeneratePreview: async () => { regenerations++ },
  }
  const server = createApp(options).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) })
  const credentials = { username: 'Tester', password: 'a-valid-password', isAdmin: true, is_admin: true }
  assert.deepEqual(await (await request('/api/auth/me')).json(), { user: null })
  for (const body of [null, {}, { username: 'a', password: 'long-password' },
    { username: 'tester', password: 'short' }, { username: 'tester', password: 'a'.repeat(129) }]) {
    assert.equal((await request('/api/auth/register', 'POST', body)).status, 400)
  }
  assert.equal((await request('/api/auth/register', 'POST', credentials)).status, 201)
  const user = store.users.get('tester')
  assert.ok(user)
  assert.equal(user.isAdmin, false)
  assert.notEqual(user.passwordHash, credentials.password)
  assert.equal((await request('/api/auth/register', 'POST', credentials)).status, 409)
  assert.equal((await request('/api/auth/login', 'POST', { ...credentials, password: 'wrong-password' })).status, 401)
  assert.equal((await request('/api/auth/login', 'POST', { ...credentials, username: 'missing' })).status, 401)
  for (const headers of [{ Origin: 'https://other.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request('/api/auth/login', 'POST', credentials, undefined, headers)).status, 403)
  }
  const login = await request('/api/auth/login', 'POST', credentials)
  assert.equal(login.status, 200)
  const setCookie = login.headers.get('set-cookie') ?? ''
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(setCookie.includes(flag))
  const cookie = setCookie.split(';')[0]
  assert.ok(cookie)
  const token = cookie.split('=')[1]
  assert.ok(token)
  assert.equal(store.sessions.has(token), false)
  assert.equal(store.sessions.has(tokenHash(token)), true)
  assert.deepEqual(await login.json(), { user: { id: user.id, username: 'tester', isAdmin: false } })
  const protectedPaths = [
    ['/api/preview/result.json', 'GET'], ['/api/preview/page-001.png', 'GET'],
    ['/api/preview/regenerate', 'GET'],
    ['/api/preview/regenerate', 'POST'], ['/api/crawler/status', 'GET'],
    ['/api/crawler/login/screenshot', 'GET'], ['/api/crawler/initialize', 'POST'],
    ['/api/crawler/start', 'POST'], ['/api/crawler/reset', 'POST'],
    ['/api/crawler/login/input', 'POST'], ['/api/crawler/organize', 'POST'],
    ['/api/map/hall-transforms.json', 'PUT'],
  ]
  for (const [path, method] of protectedPaths) {
    assert.ok(path && method)
    assert.equal((await request(path, method)).status, 401, path)
    assert.equal((await request(path, method, undefined, cookie)).status, 403, path)
  }
  assert.equal(regenerations, 0)
  assert.equal((await request('/api/preview/page-001-pdf.png')).status, 404) // Shared public Map image, not configured.
  assert.equal((await request('/api/map/final.json')).status, 404) // Public, but no asset configured.
  assert.equal((await request('/api/health')).status, 200)
  const me = await request('/api/auth/me', 'GET', undefined, cookie)
  assert.equal(me.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await me.json(), { user: { id: user.id, username: 'tester', isAdmin: false } })

  user.isAdmin = true
  assert.equal((await request('/api/preview/regenerate', 'POST', undefined, cookie)).status, 202)
  assert.equal(regenerations, 1)
  assert.equal((await request('/api/preview/regenerate', 'POST', undefined, cookie, { Origin: 'https://other.invalid' })).status, 403)
  assert.equal((await request('/api/map/hall-transforms.json', 'PUT', {}, cookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  // A new app instance resolves the persisted session, rather than relying on process-local login state.
  const restarted = createApp(options).listen(0, '127.0.0.1')
  await once(restarted, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => restarted.close(error => error ? reject(error) : resolve())))
  const restored = await fetch(`http://127.0.0.1:${(restarted.address() as AddressInfo).port}/api/auth/me`, { headers: { Cookie: cookie } })
  assert.equal((await restored.json()).user.isAdmin, true)
  user.isAdmin = false
  assert.equal((await request('/api/preview/regenerate', 'GET', undefined, cookie)).status, 403)
  const again = await request('/api/auth/login', 'POST', credentials, cookie)
  const rotated = again.headers.get('set-cookie')?.split(';')[0]
  assert.ok(rotated)
  assert.notEqual(rotated, cookie)
  assert.equal(store.sessions.has(tokenHash(token)), false)
  assert.equal((await request('/api/auth/logout', 'POST', undefined, rotated, { Origin: 'https://other.invalid' })).status, 403)
  const logout = await request('/api/auth/logout', 'POST', undefined, rotated)
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie') ?? '', /Expires=Thu, 01 Jan 1970/)
  assert.deepEqual(await (await request('/api/auth/me', 'GET', undefined, rotated)).json(), { user: null })
  await store.createSession(tokenHash(token), user.id, new Date(Date.now() - 1000))
  assert.equal((await request('/api/preview/regenerate', 'GET', undefined, cookie)).status, 401)
  assert.equal((await request('/api/preview/regenerate', 'GET', undefined, 'comike_session=malformed')).status, 401)
})

test('authentication failures fail closed and credential attempts are limited', async t => {
  const store = new MemoryAuthStore()
  const server = createApp({ checkDatabase: async () => {}, authStore: store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  store.sessionUser = async () => { throw new Error('test database unavailable') }
  for (const path of ['/api/preview/regenerate', '/api/crawler/status', '/api/auth/me']) {
    const response = await fetch(base + path, { headers: { Cookie: `comike_session=${'b'.repeat(64)}` } })
    assert.equal(response.status, 503)
  }
  for (let index = 0; index < 20; index++) {
    assert.equal((await fetch(base + '/api/auth/login', { method: 'POST' })).status, 400)
  }
  const limited = await fetch(base + '/api/auth/login', { method: 'POST' })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '900')
  const unconfigured = createApp({ checkDatabase: async () => {} }).listen(0, '127.0.0.1')
  await once(unconfigured, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => unconfigured.close(error => error ? reject(error) : resolve())))
  const url = `http://127.0.0.1:${(unconfigured.address() as AddressInfo).port}`
  assert.equal((await fetch(url + '/api/preview/regenerate')).status, 401)
  assert.equal((await fetch(url + '/api/crawler/status')).status, 401)
  assert.equal((await fetch(url + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'long-password' }),
  })).status, 503)
})
