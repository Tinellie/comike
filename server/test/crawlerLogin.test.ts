import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { chromium } from 'playwright'
import type { Browser, BrowserContextOptions } from 'playwright'
import { RemoteLogin } from '../src/crawler/login.js'
import { LoginRequiredError } from '../src/crawler/parser.js'

test('remote Chromium login supports input, confirmation, saved-session reuse and expiry recovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-login-browser-'))
  const stateFile = join(directory, 'auth.json')
  const browsers: Browser[] = []
  let validSession = true
  let probes = 0
  t.after(async () => {
    await Promise.all(browsers.map(browser => browser.close()))
    await rm(directory, { recursive: true, force: true })
  })
  async function launch() {
    const browser = await chromium.launch({ headless: true })
    browsers.push(browser)
    const newContext = browser.newContext.bind(browser)
    t.mock.method(browser, 'newContext', async (options?: BrowserContextOptions) => {
      const context = await newContext(options)
      await context.route('https://classic-webcatalog.circle.ms/**', async route => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.pathname === '/Spa') {
          probes++
          if (validSession && (await request.headerValue('cookie'))?.includes('catalog_session=valid')) {
            await route.fulfill({ contentType: 'text/html', body: '<div id="m-section-body">Authorized</div>' })
            return
          }
        }
        await route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><body style="margin:0">
              <form id="login">
                <input name="username" style="display:block;width:250px;height:40px" autofocus>
                <input name="password" type="password" style="display:block;width:250px;height:40px">
                <button>Login</button>
              </form>
              <script>
                document.getElementById('login').onsubmit = event => {
                  event.preventDefault();
                  document.cookie = 'catalog_session=valid;path=/;Secure;SameSite=Lax';
                  location.href = '/Spa';
                };
              </script>`,
        })
      })
      return context
    })
    return browser
  }
  const login = new RemoteLogin(stateFile, launch)
  await login.open()
  assert.equal(login.status().open, true)
  const screenshot = await login.screenshot()
  assert.deepEqual([...screenshot.subarray(0, 3)], [255, 216, 255])
  await assert.rejects(login.confirm(), LoginRequiredError)
  await login.input({ type: 'click', x: 70, y: 20 })
  await login.input({ type: 'text', text: 'demo-user' })
  await login.input({ type: 'key', key: 'Tab' })
  await login.input({ type: 'text', text: 'demo-password' })
  await login.input({ type: 'key', key: 'Enter' })
  assert.match(await login.cookieHeader('https://classic-webcatalog.circle.ms/Spa'), /catalog_session=valid/, 'Remote form submission must set the session cookie')
  await assert.doesNotReject(Promise.all([login.confirm(), login.confirm()]), 'Confirming the remote form login')
  assert.equal(login.status().authenticated, true)
  assert.equal(login.status().open, false)
  assert.equal(login.generation, 1)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.ok(saved.cookies.some((cookie: { name: string }) => cookie.name === 'catalog_session'))
  assert.match(await login.cookieHeader('https://classic-webcatalog.circle.ms/Spa'), /catalog_session=valid/)
  assert.equal(await login.cookieHeader('https://unrelated.example/'), '')
  await login.close()
  const restored = new RemoteLogin(stateFile, launch)
  await assert.doesNotReject(restored.waitForLogin(new AbortController().signal), 'Restoring saved login state')
  assert.equal(restored.status().authenticated, true)
  assert.equal(restored.status().open, false)
  validSession = false
  restored.invalidate()
  const controller = new AbortController()
  const waiting = restored.waitForLogin(controller.signal)
  const deadline = Date.now() + 10_000
  while (!restored.status().open) {
    if (Date.now() > deadline) throw new Error('Remote login did not reopen after expiry')
    await delay(20)
  }
  assert.equal(restored.status().authenticated, false)
  assert.ok(probes >= 4)
  controller.abort(new Error('Stopped expired-session test'))
  await assert.rejects(waiting, /Stopped expired-session test/)
  await restored.close()
})

test('a remote server failure during login verification is explicit, not treated as an expired password', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-login-unavailable-'))
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); await rm(directory, { recursive: true, force: true }) })
  const newContext = browser.newContext.bind(browser)
  t.mock.method(browser, 'newContext', async (options?: BrowserContextOptions) => {
    const context = await newContext(options)
    await context.route('https://classic-webcatalog.circle.ms/**', route =>
      route.fulfill({ status: 503, contentType: 'text/html', body: 'Unavailable' }))
    return context
  })

  const login = new RemoteLogin(join(directory, 'auth.json'), async () => browser)
  await assert.rejects(login.confirm(), /HTTP 503/)
  assert.equal(login.status().authenticated, false)
  await login.close()
})

test('login window is announced immediately while browser startup is pending, and startup failure remains visible', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comike-login-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let rejectLaunch: (error: Error) => void = () => {}
  const pendingLaunch = new Promise<Browser>((_resolve, reject) => { rejectLaunch = reject })
  let markStarted: () => void = () => {}
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const login = new RemoteLogin(join(directory, 'auth.json'), () => { markStarted(); return pendingLaunch })
  const opening = login.open()
  assert.equal(login.status().open, true)
  assert.equal(login.status().opening, true)
  await started
  rejectLaunch(new Error('Chromium startup unavailable'))
  await assert.rejects(opening, /Chromium startup unavailable/)
  assert.equal(login.status().opening, false)
  assert.equal(login.status().open, false)
  assert.match(login.status().error!, /Chromium startup unavailable/)
  await login.close()
})
