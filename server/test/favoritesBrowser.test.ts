import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { chromium } from 'playwright'
import type { BrowserContextOptions } from 'playwright'
import { RemoteLogin } from '../src/crawler/login.js'
import { collectFavorites } from '../src/favorites/source.js'
import { favoritesUrl } from '../src/favorites/parser.js'
import { FavoritesService } from '../src/favorites/service.js'
import { favoriteHtml, MemoryFavoritesStore } from './favoritesFixture.js'

test('real Chromium: ephemeral per-user login, sequential rendered pagination, computed colours and actual logout on success/failure', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const newContext = browser.newContext.bind(browser)
  let contextNumber = 0
  const visits = new Map<number, number[]>()
  const logouts: number[] = []
  const failureContexts = new Set<number>()
  t.mock.method(browser, 'newContext', async (options?: BrowserContextOptions) => {
    assert.equal(options?.storageState, undefined)
    const context = await newContext(options)
    const number = ++contextNumber
    visits.set(number, [])
    await context.route('https://classic-webcatalog.circle.ms/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname === '/Account/LogOut') {
        logouts.push(number)
        await route.fulfill({ contentType: 'text/html',
          headers: { 'Set-Cookie': 'catalog_session=;Path=/;Max-Age=0;Secure;SameSite=Lax' },
          body: '<html><body>Logged out <input type="password"></body></html>' })
        return
      }
      if ((await request.headerValue('cookie'))?.includes(`catalog_session=user-${number}`)) {
        const page = Number(url.searchParams.get('page'))
        visits.get(number)!.push(page)
        if (failureContexts.has(number) && page === 2) {
          await route.fulfill({ status: 503, body: 'Unavailable' })
          return
        }
        await route.fulfill({ contentType: 'text/html', body: favoriteHtml(page)
          .replace('</style>', 'td.favorite-color { background-color: rgb(0, 181, 74) !important; }</style>') })
        return
      }
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>
        <form><input name="username" autofocus><input type="password" name="password"><button>Login</button></form>
        <script>document.querySelector('form').onsubmit = event => {
          event.preventDefault(); document.cookie = 'catalog_session=user-${number};Path=/;Secure;SameSite=Lax';
          location.href = '/User/Favorites?count=100&page=1';
        };</script></body>` })
    })
    return context
  })

  const first = new RemoteLogin(undefined, async () => browser, favoritesUrl, 'table.t-user-favorites')
  const second = new RemoteLogin(undefined, async () => browser, favoritesUrl, 'table.t-user-favorites')
  async function authenticate(login: RemoteLogin) {
    await login.open()
    await login.input({ type: 'text', text: 'synthetic-user' })
    await login.input({ type: 'key', key: 'Tab' })
    await login.input({ type: 'text', text: 'synthetic-password' })
    await login.input({ type: 'key', key: 'Enter' })
    await login.confirm()
  }
  await authenticate(first)
  await second.open()
  assert.equal(await second.cookieHeader(favoritesUrl), '')
  assert.match(await first.cookieHeader(favoritesUrl), /catalog_session=user-1/)
  await authenticate(second)
  assert.match(await second.cookieHeader(favoritesUrl), /catalog_session=user-2/)
  visits.set(1, [])
  const progress: number[] = []
  const entries = await collectFavorites(first, new AbortController().signal, page => progress.push(page))
  assert.deepEqual(visits.get(1), [1, 2])
  assert.deepEqual(progress, [1, 2])
  assert.equal(entries.length, 101)
  assert.equal(entries[0]?.colour, '#00B54A', 'Use computed cell colour rather than hardcoded palette')
  assert.equal(entries[100]?.boothId, '24000100')
  await first.logout()
  assert.deepEqual(logouts, [1])
  assert.equal(await first.cookieHeader(favoritesUrl), '')
  assert.match(await second.cookieHeader(favoritesUrl), /catalog_session=user-2/, 'Logging out one context must not clear another')

  const store = new MemoryFavoritesStore()
  const old = [{ boothId: 'old', colour: '#000000', memo: 'keep' }]
  store.records.set('second-user', old)
  failureContexts.add(2)
  const service = new FavoritesService(store, () => second)
  t.after(() => service.close())
  service.start('second-user')
  const deadline = Date.now() + 10_000
  let status = await service.status('second-user')
  while (status.status !== 'failed') {
    if (Date.now() > deadline) throw new Error('Failure cleanup timed out')
    await delay(20)
    status = await service.status('second-user')
  }
  assert.deepEqual(logouts, [1, 2], 'A failed page still triggers the real logout link')
  assert.deepEqual(store.records.get('second-user'), old)
  assert.equal(status.login.authenticated, false)
  assert.equal(status.login.open, false)
})
