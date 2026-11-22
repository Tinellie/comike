import { constants, existsSync } from 'node:fs'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const [command = 'serve', ...args] = process.argv.slice(2)

async function seed() {
  for (const directory of ['ref', 'storage', '.local', 'tools/booth-recognition/output/official-map']) {
    await mkdir(resolve(root, directory), { recursive: true })
  }
  for (const name of ['hall-meta.json', 'hall-transforms.json', 'osm-map.osm', 'ref.osm', 'official-map.pdf']) {
    const target = resolve(root, 'ref', name)
    if (!existsSync(target)) await copyFile(resolve(root, 'seed/ref', name), target, constants.COPYFILE_EXCL)
  }
}

function configureDatabase() {
  if (process.env.DATABASE_URL) return
  for (const key of ['DATABASE_HOST', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME']) {
    if (!process.env[key] || process.env[key] === 'CHANGE_ME') throw new Error(`Set ${key} before starting the container`)
  }
  const url = new URL('mysql://localhost:3306/')
  url.hostname = process.env.DATABASE_HOST
  url.username = process.env.DATABASE_USER
  url.password = process.env.DATABASE_PASSWORD
  url.pathname = `/${process.env.DATABASE_NAME}`
  process.env.DATABASE_URL = url.href
}

try {
  if (command === 'seed') {
    await seed()
    console.info('Missing reference assets initialized; existing files were preserved')
  } else if (command === 'browser-check') {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent('<title>Comike browser check</title>')
      if (await page.title() !== 'Comike browser check') throw new Error('Chromium smoke test failed')
      console.info('Chromium ready')
    } finally { await browser.close() }
  } else if (command === 'serve') {
    configureDatabase()
    const directory = resolve(root, 'tools/booth-recognition/output/official-map')
    const final = JSON.parse(await readFile(resolve(directory, 'final.json'), 'utf8'))
    if (!Array.isArray(final.halls) || !final.halls.length) throw new Error('Upload valid map recognition results before starting')
    await access(resolve(directory, 'result.json'), constants.R_OK)
    await access(resolve(root, 'ref/osm-map.osm'), constants.R_OK)
    await access(resolve(root, 'ref/hall-transforms.json'), constants.W_OK)
    for (const hall of final.halls) {
      const image = hall.pdfPreview?.image
      if (typeof image !== 'string' || !/^page-\d{3}-pdf\.png$/.test(image)) throw new Error('Map PDF preview metadata is missing or invalid')
      await access(resolve(directory, image), constants.R_OK)
    }
    await import('../server/dist/index.js')
  } else if (command === 'migrate') {
    configureDatabase()
    await import('../server/dist/db/init.js')
  } else if (command === 'admin') {
    configureDatabase()
    process.argv = [process.execPath, resolve(root, 'server/dist/auth/admin.js'), ...args]
    await import('../server/dist/auth/admin.js')
  } else {
    throw new Error('Usage: entrypoint.mjs serve|seed|migrate|browser-check|admin <username> grant|revoke')
  }
} catch (error) {
  console.error('Container command failed:', error)
  process.exitCode = 1
}
