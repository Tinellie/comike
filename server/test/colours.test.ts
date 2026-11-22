import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { tokenHash } from '../src/auth/routes.js'
import { ColourOrderConflictError, MysqlColourStore } from '../src/colours/repository.js'
import type { ColourStore } from '../src/colours/repository.js'
import { db, pool } from '../src/db/index.js'
import { userColourPriorities, userFavorites, users } from '../src/db/schema.js'
import { MysqlFavoritesStore } from '../src/favorites/repository.js'
import { MemoryAuthStore } from './authFixture.js'

test('colour endpoints require a session, reject cross-site writes and derive ownership exclusively from the session', async t => {
  const auth = new MemoryAuthStore()
  for (const [id, token] of [['first', 'a'], ['second', 'b']] as const) {
    auth.users.set(id, { id, username: id, isAdmin: false, passwordHash: '' })
    await auth.createSession(tokenHash(token.repeat(64)), id, new Date(Date.now() + 60_000))
  }
  const scopes: string[] = []
  const records = new Map([
    ['first', [{ colour: '#FF0000', priority: 0, coefficient: 1 }, { colour: '#00B54A', priority: 1, coefficient: 1 }]],
    ['second', [{ colour: '#FF0000', priority: 0, coefficient: 1 }]],
  ])
  const store: ColourStore = {
    async list(id) { scopes.push(id); return records.get(id)! },
    async reorder(id, colours) {
      scopes.push(id)
      const current = records.get(id)!
      if (colours.length !== current.length || colours.some(colour => !current.some(entry => entry.colour === colour))) {
        throw new ColourOrderConflictError('颜色列表已变更')
      }
      const result = colours.map((colour, priority) => ({ ...current.find(entry => entry.colour === colour)!, priority }))
      records.set(id, result)
      return result
    },
    async setCoefficient(id, colour, coefficient) {
      scopes.push(id)
      const entry = records.get(id)?.find(entry => entry.colour === colour)
      if (!entry) throw new ColourOrderConflictError('颜色列表已变更')
      entry.coefficient = coefficient
    },
  }
  const server = createApp({ checkDatabase: async () => {}, authStore: auth, colourStore: store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/colours`
  const first = { Cookie: `comike_session=${'a'.repeat(64)}`, 'Content-Type': 'application/json' }
  const second = { Cookie: `comike_session=${'b'.repeat(64)}` }
  for (const method of ['GET', 'PUT']) assert.equal((await fetch(base, { method })).status, 401)
  const palette = await fetch(base, { headers: first })
  assert.equal(palette.status, 200)
  assert.equal(palette.headers.get('cache-control'), 'private, no-store')
  assert.match(palette.headers.get('vary') ?? '', /Cookie/)
  assert.deepEqual(await palette.json(), { colours: records.get('first') })
  assert.equal(scopes.at(-1), 'first')
  const put = (body: unknown, headers = first) => fetch(base, { method: 'PUT', headers, body: JSON.stringify(body) })
  const patch = (body: unknown, headers = first) => fetch(`${base}/coefficient`, { method: 'PATCH', headers, body: JSON.stringify(body) })
  assert.equal((await patch({ colour: '#FF0000', coefficient: 0 }, { 'Content-Type': 'application/json' })).status, 401)
  assert.equal((await patch({ colour: '#FF0000', coefficient: 0 }, { ...first, Origin: 'https://other.invalid' })).status, 403)
  for (const coefficient of [-1, 0.001, 1001, '2', null]) {
    assert.equal((await patch({ colour: '#FF0000', coefficient })).status, 400)
  }
  assert.equal((await patch({ colour: '#FF0000', coefficient: 2, userId: 'second' })).status, 400)
  assert.equal((await patch({ colour: '#0000FF', coefficient: 2 })).status, 409)
  assert.equal((await patch({ colour: '#FF0000', coefficient: 0 })).status, 204)
  assert.equal(scopes.at(-1), 'first')
  const reordered = await put({ colours: ['#00B54A', '#FF0000'] })
  assert.equal(reordered.status, 200)
  assert.deepEqual(await reordered.json(), { colours: [{ colour: '#00B54A', priority: 0, coefficient: 1 }, { colour: '#FF0000', priority: 1, coefficient: 0 }] })
  const other = await fetch(base, { headers: second })
  assert.deepEqual(await other.json(), { colours: [{ colour: '#FF0000', priority: 0, coefficient: 1 }] })
  assert.equal(scopes.at(-1), 'second')
  const before = scopes.length
  for (const invalid of [null, [], {}, { colours: 'red' }, { colours: [null] }, { colours: ['red'] },
    { colours: ['#ff0000'] }, { colours: ['#FF0000', '#FF0000'] }, { colours: [], userId: 'second' }]) {
    assert.equal((await put(invalid)).status, 400)
  }
  assert.equal((await fetch(`${base}?userId=second`, { headers: first })).status, 400)
  assert.equal((await put({ colours: ['#00B54A', '#FF0000'] }, { ...first, Origin: 'https://other.invalid' })).status, 403)
  assert.equal(scopes.length, before)
  assert.equal((await put({ colours: ['#FF0000'] })).status, 409)
  assert.equal((await put({ colours: ['#0000FF', '#FF0000'] })).status, 409)
  t.mock.method(store, 'list', async () => { throw new Error('test database unavailable') })
  assert.equal((await fetch(base, { headers: first })).status, 503)
  t.mock.method(store, 'reorder', async () => { throw new Error('test database unavailable') })
  assert.equal((await put({ colours: ['#FF0000', '#00B54A'] })).status, 503)
})

test('MySQL colour preferences persist per numeric user, synchronize imports and reject stale/partial orders atomically',
  { skip: !db && 'Run with the server .env loaded for the MySQL integration check' }, async t => {
    t.after(() => pool!.end())
    const rollback = new Error('Rollback synthetic colour preference records')
    await assert.rejects(db!.transaction(async tx => {
      const firstId = randomUUID(), secondId = randomUUID()
      await tx.insert(users).values([
        { id: firstId, username: `cp_${firstId.slice(0, 20)}`, password_hash: 'test-only', created_at: new Date() },
        { id: secondId, username: `cp_${secondId.slice(0, 20)}`, password_hash: 'test-only', created_at: new Date() },
      ])
      const [first] = await tx.select({ id: users.internal_id }).from(users).where(eq(users.id, firstId))
      const [second] = await tx.select({ id: users.internal_id }).from(users).where(eq(users.id, secondId))
      const store = new MysqlColourStore(tx)
      const favorites = new MysqlFavoritesStore(tx)
      assert.deepEqual(await store.list(firstId), [])
      assert.deepEqual(await store.reorder(firstId, []), [])
      await tx.insert(userFavorites).values([
        { user_id: first!.id, booth_id: 'colour-test-1', colour: '#FF0000', memo: '' },
        { user_id: first!.id, booth_id: 'colour-test-2', colour: '#00B54A', memo: '' },
        { user_id: first!.id, booth_id: 'colour-test-3', colour: '#FF0000', memo: '' },
        { user_id: second!.id, booth_id: 'colour-test-1', colour: '#0000FF', memo: '' },
      ])
      assert.deepEqual(await store.list(firstId), [{ colour: '#00B54A', priority: 0, coefficient: 1 }, { colour: '#FF0000', priority: 1, coefficient: 1 }])
      await store.setCoefficient(firstId, '#FF0000', 0)
      await store.setCoefficient(firstId, '#00B54A', 2.5)
      await assert.rejects(store.setCoefficient(firstId, '#0000FF', 2), ColourOrderConflictError)
      const custom = [{ colour: '#FF0000', priority: 0, coefficient: 0 }, { colour: '#00B54A', priority: 1, coefficient: 2.5 }]
      assert.deepEqual(await store.reorder(firstId, custom.map(entry => entry.colour)), custom)
      assert.deepEqual(await new MysqlColourStore(tx).list(firstId), custom)
      assert.deepEqual(await store.list(secondId), [{ colour: '#0000FF', priority: 0, coefficient: 1 }])
      for (const invalid of [[], ['#0000FF', '#FF0000'], ['#FF0000'], ['#FF0000', '#FF0000']]) {
        await assert.rejects(store.reorder(firstId, invalid), ColourOrderConflictError)
        assert.deepEqual(await store.list(firstId), custom)
      }
      await favorites.replace(firstId, [{ boothId: 'colour-test-new', colour: '#000000', memo: '' }])
      const appended = [...custom, { colour: '#000000', priority: 2, coefficient: 1 }]
      assert.deepEqual(await store.list(firstId), appended)
      assert.equal(await favorites.count(firstId), 1)
      assert.equal(await favorites.count(secondId), 1)
      assert.deepEqual(await store.list(secondId), [{ colour: '#0000FF', priority: 0, coefficient: 1 }])
      await assert.rejects(store.reorder(firstId, custom.map(entry => entry.colour)), ColourOrderConflictError)
      await favorites.replace(firstId, [])
      assert.deepEqual(await store.list(firstId), appended)
      await favorites.replace(firstId, [{ boothId: 'colour-test-returned', colour: '#FF0000', memo: '' }])
      assert.deepEqual(await store.list(firstId), appended)
      await assert.rejects(store.list(randomUUID()), /no longer exists/)
      await tx.delete(users).where(eq(users.id, firstId))
      assert.deepEqual(await tx.select().from(userColourPriorities).where(eq(userColourPriorities.user_id, first!.id)), [])
      throw rollback
    }), error => error === rollback)
  })
