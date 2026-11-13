import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { regeneratePreview } from '../src/regeneratePreview.js'

test('regeneration runs the existing PDF pipeline with fixed paths and all pages', async t => {
  const child = new ChildProcess()
  const spawn = t.mock.method(childProcess.default, 'spawn', () => child)
  syncBuiltinESMExports()
  t.after(() => {
    spawn.mock.restore()
    syncBuiltinESMExports()
  })
  const root = join(process.cwd(), 'fixture-root')
  const output = join(root, 'output')
  const run = regeneratePreview(root, output)
  const tool = join(root, 'tools', 'booth-recognition')
  assert.deepEqual(spawn.mock.calls[0].arguments, [
    process.platform === 'win32' ? join(tool, '.venv', 'Scripts', 'python.exe') : join(tool, '.venv', 'bin', 'python'),
    ['-u', join(tool, 'test_recognition.py'), join(root, 'ref', 'official-map.pdf'), '--pages', 'all', '--output', output],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  ])
  child.emit('close', 0, null)
  await run
  const failed = regeneratePreview(root, output)
  child.emit('close', 2, null)
  await assert.rejects(failed, /exit 2/)
  const missing = regeneratePreview(root, output)
  child.emit('error', new Error('spawn ENOENT'))
  await assert.rejects(missing, /ENOENT/)
})

test('regeneration API reports progress, rejects duplicates, and permits retry after failure', async t => {
  let finish: (() => void) | undefined
  let fail: ((reason: Error) => void) | undefined
  let calls = 0
  const app = createApp({
    checkDatabase: async () => {},
    hallEditorOrigin: 'http://localhost:5173',
    regeneratePreview: () => {
      calls++
      return new Promise<void>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
    },
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/preview/regenerate`
  const status = async () => {
    const response = await fetch(url)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return response.json()
  }
  assert.deepEqual(await status(), { status: 'idle' })
  for (const headers of [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 403)
  }
  assert.equal(calls, 0)
  const started = await fetch(url, { method: 'POST', headers: { Origin: 'http://localhost:5173' } })
  assert.equal(started.status, 202)
  assert.deepEqual(await started.json(), { status: 'running' })
  assert.deepEqual(await status(), { status: 'running' })
  assert.equal((await fetch(url, { method: 'POST' })).status, 409)
  assert.equal(calls, 1)
  assert.ok(finish)
  finish()
  assert.deepEqual(await status(), { status: 'succeeded' })
  assert.equal((await fetch(url, { method: 'POST' })).status, 202)
  assert.ok(fail)
  fail(new Error('OCR failure'))
  const failure = await status()
  assert.equal(failure.status, 'failed')
  assert.match(failure.message, /Python/)
  assert.equal((await fetch(url, { method: 'POST' })).status, 202)
  assert.equal(calls, 3)
  assert.ok(finish)
  finish()
  assert.deepEqual(await status(), { status: 'succeeded' })
})

test('unconfigured regeneration is an explicit service error', async t => {
  const server = createApp({ checkDatabase: async () => {} }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/preview/regenerate`, { method: 'POST' })
  assert.equal(response.status, 503)
  assert.match((await response.json()).message, /not configured/)
})
