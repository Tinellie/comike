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
  await writeFile(join(directory, 'result.json'), JSON.stringify({ schemaVersion: 1, pages: [] }))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=',
    'base64',
  )
  await writeFile(join(directory, 'page-001.png'), png)
  let databaseAvailable = true
  const app = createApp({
    clientDirectory: directory,
    recognitionDirectory: directory,
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
  await t.test('preview serves recognition JSON and original PNG', async () => {
    const data = await fetch(`${base}/api/preview/result.json`)
    assert.equal(data.status, 200)
    assert.deepEqual(await data.json(), { schemaVersion: 1, pages: [] })
    const image = await fetch(`${base}/api/preview/page-001.png`)
    assert.equal(image.status, 200)
    assert.match(image.headers.get('content-type') ?? '', /image\/png/)
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
  })
  await t.test('missing preview images return JSON errors', async () => {
    const response = await fetch(`${base}/api/preview/page-099.png`)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), {
      message: 'Recognition output not found. Run the recognition script first.',
    })
  })
  await t.test('preview does not expose arbitrary files or pre-rendered overlays', async () => {
    for (const name of ['index.html', 'page-001-overlay.png', '%2e%2e%2findex.html']) {
      const response = await fetch(`${base}/api/preview/${name}`)
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { message: 'API route not found' })
    }
  })
  await t.test('home, map and preview serve the SPA entry', async () => {
    for (const path of ['/', '/map', '/preview']) {
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
