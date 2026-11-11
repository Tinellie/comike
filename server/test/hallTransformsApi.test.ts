import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.ts'

test('Hall files are whitelisted and transform writes persist only validated configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-hall-api-'))
  const final = { halls: [{ name: 'East' }] }
  const initial = {
    schemaVersion: 1,
    placements: [{
      hallIndex: 0, name: 'East', anchor: { latitude: 35.63, longitude: 139.79 },
      offset: { x: 20, y: -30 }, rotation: 90, scale: 0.1,
    }],
  }
  const file = join(directory, 'hall-transforms.json')
  await writeFile(join(directory, 'final.json'), JSON.stringify(final))
  await writeFile(file, JSON.stringify(initial))
  const app = createApp({
    checkDatabase: async () => {}, recognitionDirectory: directory, hallTransformsFile: file,
    hallEditorOrigin: 'http://localhost:5173',
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true })
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const put = (value: unknown, origin?: string) => fetch(`${base}/api/map/hall-transforms.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(value),
  })
  for (const [name, expected] of [['final.json', final], ['hall-transforms.json', initial]] as const) {
    const response = await fetch(`${base}/api/map/${name}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), expected)
  }
  for (const name of ['result.json', 'other.json', '%2e%2e%2fhall-transforms.json']) {
    assert.equal((await fetch(`${base}/api/map/${name}`)).status, 404)
  }
  for (const value of [
    {}, { ...initial, placements: [] },
    { ...initial, placements: [{ ...initial.placements[0], scale: -1 }] },
    { ...initial, placements: [{ ...initial.placements[0], name: 'Wrong' }] },
    { ...initial, placements: [{ ...initial.placements[0], file: 'arbitrary.json' }] },
  ]) assert.equal((await put(value)).status, 400)
  assert.equal((await put(initial, 'https://other.invalid')).status, 403)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), initial)
  const updated = structuredClone(initial)
  updated.placements[0].rotation = -45
  updated.placements[0].offset.x = 82
  assert.equal((await put(updated, base)).status, 200)
  assert.equal((await put(updated, 'http://localhost:5173')).status, 200)
  assert.deepEqual(await (await fetch(`${base}/api/map/hall-transforms.json`)).json(), updated)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), updated)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'final.json'), 'utf8')), final)
  assert.deepEqual((await readdir(directory)).sort(), ['final.json', 'hall-transforms.json'])
  await rm(file)
  assert.equal((await fetch(`${base}/api/map/hall-transforms.json`)).status, 404)
})
