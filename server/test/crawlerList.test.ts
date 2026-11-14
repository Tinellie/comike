import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Configuration } from 'crawlee'
import { collectList, parseSyllabary, syllabaryUrl } from '../src/crawler/list.js'
import { LoginRequiredError } from '../src/crawler/parser.js'

const sample = await readFile(new URL('../../ref/circle-list.html', import.meta.url), 'utf8')

test('real syllabary sample contains three days, ten rows and static circle links without an eventId', () => {
  const parsed = parseSyllabary(sample, syllabaryUrl)
  assert.deepEqual(parsed.days.map(([day]) => day), [1, 2, 3])
  assert.deepEqual(parsed.columns.map(([column]) => column), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(parsed.day, 1)
  assert.equal(parsed.column, 0)
  assert.equal(parsed.eventId, null)
  assert.ok(parsed.ids.includes('24035403'))
  assert.ok(parsed.ids.includes('24006844'))
  assert.ok(parsed.ids.length > 1000)
  assert.throws(() => parseSyllabary(sample, `${syllabaryUrl}?Day=2`), /日期/)
  assert.throws(() => parseSyllabary('<html>Unavailable</html>', syllabaryUrl), /日期/)
})

function fixture(day: number, column: number) {
  const labels = ['あ行', 'か行', 'さ行']
  const days = [1, 2].map(value =>
    `<li><a href="/Circle/Syllabary?Day=${value}" class="${value === day ? 'date_hover' : ''}">${value}日目</a></li>`).join('')
  const rows = labels.map((label, index) => index === column ? `<li>${label}</li>`
    : `<li><a href="/Circle/Syllabary?column=${index}&genreCode=filtered">${label}</a></li>`).join('')
  const circles = day === 2 && column === 2 ? '' : `<a href="/Circle/${day}0${column}">Circle</a><a href="/Circle/999">Repeated</a>`
  return `<ul class="date-list">${days}</ul><ul class="sortnav-list">${rows}</ul><div class="md-circlelist">${circles}</div>
    <aside><a href="/Circle/888">Not in list</a></aside>`
}

for (const mode of ['success', 'failure', 'login-html', '401', '403', 'wrong-day'] as const) {
  test(`static syllabary traversal: ${mode}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'comike-syllabary-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const requests: string[] = []
    let cookieSeen = false
    const server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost')
      const day = Number(url.searchParams.get('Day') ?? 1)
      const column = Number(url.searchParams.get('column') ?? 0)
      requests.push(`${day}:${column}`)
      cookieSeen ||= request.headers.cookie === 'catalog_session=test'
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      assert.equal(url.searchParams.has('genreCode'), false)
      if (day === 1 && column === 1) {
        if (mode === 'failure') { response.statusCode = 503; response.end('Unavailable'); return }
        if (mode === '401' || mode === '403') { response.statusCode = Number(mode); response.end('Unauthorized'); return }
        if (mode === 'login-html') { response.end('<input type="password">'); return }
      }
      response.end(fixture(mode === 'wrong-day' && day === 2 ? 1 : day, column))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const actions: string[] = []
    const run = collectList({
      startUrl: `http://127.0.0.1:${address.port}/Circle/Syllabary`,
      login: { cookieHeader: async () => 'catalog_session=test' },
      config: new Configuration({
        persistStorage: false, purgeOnStart: false,
        storageClientOptions: { localDataDirectory: directory },
      }),
      signal: new AbortController().signal,
      progress: async (_ids, _eventId, action) => { actions.push(action) },
    })
    if (mode === 'success') {
      const result = await run
      assert.deepEqual(requests, ['1:0', '1:1', '1:2', '2:0', '2:1', '2:2'])
      assert.deepEqual(result.ids.sort(), ['100', '101', '102', '200', '201', '999'])
      assert.equal(result.eventId, null)
      assert.equal(cookieSeen, true)
      assert.ok(actions.some(action => action.includes('6/6')))
    } else {
      await assert.rejects(run, ['401', '403', 'login-html'].includes(mode) ? LoginRequiredError : Error)
    }
  })
}
