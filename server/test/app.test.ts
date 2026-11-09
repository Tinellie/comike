import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.js'

test('Express APIs and SPA deep links', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-test-'))
  const html = '<!doctype html><div id="root"></div>'
  await writeFile(join(directory, 'index.html'), html)
  let databaseAvailable = true
  const app = createApp({
    clientDirectory: directory,
    checkDatabase: async () => {
      if (!databaseAvailable) {
        throw new Error('Test database unavailable')
      }
    },
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await rm(directory, { recursive: true })
  })
  const address = server.address() as AddressInfo
  const base = `http://127.0.0.1:${address.port}`

  await t.test('health endpoint', async () => {
    const response = await fetch(`${base}/api/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })
  await t.test('database success', async () => {
    const response = await fetch(`${base}/api/health/db`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  })
  await t.test('database failure is explicit', async () => {
    databaseAvailable = false
    const response = await fetch(`${base}/api/health/db`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { status: 'error', message: 'Database unavailable' })
  })
  await t.test('unknown API does not return SPA HTML', async () => {
    const response = await fetch(`${base}/api/missing`)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { message: 'API route not found' })
  })
  await t.test('home and map serve the SPA entry', async () => {
    for (const path of ['/', '/map']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), html)
    }
  })
  await t.test('invalid JSON returns an explicit client error', async () => {
    const response = await fetch(`${base}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { message: 'Invalid JSON body' })
  })
})
