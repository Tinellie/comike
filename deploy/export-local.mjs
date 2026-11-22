import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

function run(command, args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)))
  })
}

try {
  loadEnvFile(resolve(root, 'server/.env'))
  const url = new URL(process.env.DATABASE_URL ?? '')
  if (url.protocol !== 'mysql:' || !/^\/[a-zA-Z0-9_]{1,64}$/.test(url.pathname)) throw new Error('Set a valid local MySQL DATABASE_URL')
  const directories = {
    storage: resolve(root, process.env.MEDIA_ROOT ?? 'storage'),
    map: resolve(root, 'tools/booth-recognition/output/official-map'),
    ref: resolve(root, 'ref'),
  }
  for (const directory of Object.values(directories)) await access(directory)
  const output = resolve(root, 'backups', `export-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(output, { recursive: true, mode: 0o700 })
  await run(process.env.MYSQLDUMP_PATH || 'mysqldump', [
    '--host', url.hostname, '--port', url.port || '3306', '--user', decodeURIComponent(url.username),
    '--single-transaction', '--quick', '--no-tablespaces', '--set-gtid-purged=OFF', '--hex-blob',
    '--default-character-set=utf8mb4', '--result-file', resolve(output, 'database.sql'), url.pathname.slice(1),
  ], { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) })
  for (const [name, directory] of Object.entries(directories)) {
    await run('tar', ['-czf', resolve(output, `${name}.tar.gz`), '-C', directory,
      ...(name === 'ref' ? ['hall-meta.json', 'hall-transforms.json', 'osm-map.osm', 'ref.osm', 'official-map.pdf'] : ['.'])])
  }
  console.info(`Export ready: ${output}`)
  console.info('Contains private user data. Transfer over SSH; do not commit or publish. Circle.ms login state is intentionally excluded.')
} catch (error) {
  console.error('Local export failed. Install the MySQL 8.4 client or set MYSQLDUMP_PATH if mysqldump is missing:', error)
  process.exitCode = 1
}
