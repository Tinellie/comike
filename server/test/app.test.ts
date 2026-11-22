import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { get } from 'node:http'
import { createAdminApp as createApp } from './authFixture.js'
import { createApp as createPublicApp } from '../src/app.js'

test('Map PDF originals remain public without exposing other preview assets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-public-pdf-'))
  await writeFile(join(directory, 'page-001-pdf.png'), 'pdf image fixture')
  const server = createPublicApp({ checkDatabase: async () => {}, recognitionDirectory: directory }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true })
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/preview`
  const image = await fetch(`${base}/page-001-pdf.png`)
  assert.equal(image.status, 200)
  assert.equal(await image.text(), 'pdf image fixture')
  assert.equal((await fetch(`${base}/page-001-pdf.png`, { method: 'HEAD' })).status, 200)
  for (const name of ['result.json', 'page-001.png', 'page-001-pdf.png/extra', 'page-001-paths.json', 'regenerate']) {
    assert.equal((await fetch(`${base}/${name}`)).status, 401)
  }
  assert.equal((await fetch(`${base}/page-001-pdf.png`, { method: 'PUT' })).status, 401)
})

test('aborted map and preview downloads do not crash the server or modify sent headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-abort-test-'))
  const payload = Buffer.alloc(8 * 1024 * 1024, 32)
  for (const name of ['osm-map.osm', 'final.json', 'hall-transforms.json', 'result.json']) {
    await writeFile(join(directory, name), payload)
  }
  const app = createApp({
    checkDatabase: async () => {},
    recognitionDirectory: directory,
    osmFile: join(directory, 'osm-map.osm'),
    hallTransformsFile: join(directory, 'hall-transforms.json'),
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true })
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (const path of [
    '/api/map/osm-map.osm', '/api/map/final.json',
    '/api/map/hall-transforms.json', '/api/preview/result.json',
  ]) {
    await new Promise<void>((resolve, reject) => {
      const request = get(base + path, response => {
        assert.equal(response.statusCode, 200)
        response.once('data', () => response.destroy())
        response.once('close', resolve)
        response.once('error', reject)
      })
      request.once('error', reject)
    })
    const health = await fetch(`${base}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok' })
  }
  const response = await fetch(`${base}/api/map/osm-map.osm`)
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload)
})

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
  await writeFile(join(directory, 'page-001-pdf.png'), png)
  const paths = { width: 40, height: 20, segments: [[1, 2, 19, 2]] }
  await writeFile(join(directory, 'page-001-paths.json'), JSON.stringify(paths))
  const osm = '<osm version="0.6"><node id="1" lat="35.63" lon="139.79"/></osm>'
  await writeFile(join(directory, 'osm-map.osm'), osm)
  let databaseAvailable = true
  const app = createApp({
    clientDirectory: directory,
    recognitionDirectory: directory,
    osmFile: join(directory, 'osm-map.osm'),
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
    const fullPage = await fetch(`${base}/api/preview/page-001-pdf.png`)
    assert.equal(fullPage.status, 200)
    assert.match(fullPage.headers.get('content-type') ?? '', /image\/png/)
    assert.deepEqual(Buffer.from(await fullPage.arrayBuffer()), png)
  })
  await t.test('missing preview images return JSON errors', async () => {
    const response = await fetch(`${base}/api/preview/page-099.png`)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), {
      message: 'Recognition output not found. Run the recognition script first.',
    })
  })
  await t.test('admin preview serves the generated path graph', async () => {
    const response = await fetch(`${base}/api/preview/page-001-paths.json`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), paths)
  })
  await t.test('preview does not expose arbitrary files or pre-rendered overlays', async () => {
    for (const name of ['index.html', 'page-001-overlay.png', '%2e%2e%2findex.html']) {
      const response = await fetch(`${base}/api/preview/${name}`)
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { message: 'API route not found' })
    }
  })
  await t.test('map serves only its configured OSM file', async () => {
    const response = await fetch(`${base}/api/map/osm-map.osm`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/xml/)
    assert.equal(await response.text(), osm)
    for (const name of ['index.html', 'other.osm', '%2e%2e%2findex.html']) {
      const forbidden = await fetch(`${base}/api/map/${name}`)
      assert.equal(forbidden.status, 404)
      assert.deepEqual(await forbidden.json(), { message: 'API route not found' })
    }
  })
  await t.test('missing OSM file returns an explicit JSON error', async () => {
    await rm(join(directory, 'osm-map.osm'))
    const response = await fetch(`${base}/api/map/osm-map.osm`)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await response.json(), { message: 'OSM map not found. Add ref/osm-map.osm first.' })
  })
  await t.test('home, map, preview and login serve the SPA entry', async () => {
    for (const path of ['/', '/map', '/preview', '/login']) {
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
