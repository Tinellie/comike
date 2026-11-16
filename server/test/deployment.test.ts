import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const entrypoint = fileURLToPath(new URL('../../deploy/entrypoint.mjs', import.meta.url))

test('container seeding initializes writable directories without overwriting user map transforms', async t => {
  const root = await mkdtemp(join(tmpdir(), 'comike-container-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'deploy'))
  await mkdir(join(root, 'seed', 'ref'), { recursive: true })
  await mkdir(join(root, 'ref'))
  await copyFile(entrypoint, join(root, 'deploy', 'entrypoint.mjs'))
  const names = ['hall-meta.json', 'hall-transforms.json', 'osm-map.osm', 'official-map.pdf']
  for (const name of names) await writeFile(join(root, 'seed', 'ref', name), `seed:${name}`)
  await writeFile(join(root, 'ref', 'hall-transforms.json'), 'personal transforms')
  for (let attempt = 0; attempt < 2; attempt++) {
    await run(process.execPath, [join(root, 'deploy', 'entrypoint.mjs'), 'seed'], { cwd: tmpdir() })
    for (const name of names) {
      assert.equal(await readFile(join(root, 'ref', name), 'utf8'),
        name === 'hall-transforms.json' ? 'personal transforms' : `seed:${name}`)
    }
    for (const directory of ['storage', '.local', 'tools/booth-recognition/output/official-map']) {
      assert.equal((await stat(join(root, directory))).isDirectory(), true)
    }
  }
})

test('container commands reject invalid commands and missing database settings explicitly', async () => {
  await assert.rejects(run(process.execPath, [entrypoint, 'invalid-command']), /Usage:/)
  await assert.rejects(run(process.execPath, [entrypoint, 'migrate'], {
    env: { ...process.env, DATABASE_URL: '', DATABASE_HOST: '' },
  }), /Set DATABASE_HOST/)
})
