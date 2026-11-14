import type { FavoritesStore } from '../src/favorites/repository.js'
import type { Favorite } from '../src/favorites/parser.js'
import type { ImportLogin } from '../src/favorites/service.js'
import type { BrowserInput } from '../src/crawler/login.js'

export function favoriteHtml(page = 1, total = 101) {
  const pages = Math.max(1, Math.ceil(total / 100))
  const start = (page - 1) * 100
  const rows = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, index) => {
    const id = String(24000000 + start + index)
    return `<tr class="webcatalog-circle-list-detail" id="${id}">
      <td class="favorite-color favorite-color-3" rowspan="3"></td>
      <td class="infotable-circlename"><a href="/Circle/${id}">Circle</a></td></tr>
      <tr><td><span data-bind="text: favMemo(), visible: !favMemoEditing()">memo ${id}</span></td></tr>
      <tr><td>Controls</td></tr>`
  }).join('')
  return `<!doctype html><html><head><meta charset="UTF-8"><style>td.favorite-color-3 {background: #FFF700;}</style></head>
    <body><div id="mainSection">
    <a href="/Account/LogOut">ログアウト</a>
    <div class="m-pagination"><a href="/User/Favorites?count=100&amp;page=${pages}">${pages}</a>
      <p class="m-pagination-label">${total} 件中 ${total ? start + 1 : 0} 件目 - ${Math.min(page * 100, total)} 件目</p></div>
    <table class="t-user-favorites"><tbody>${rows}</tbody></table></div></body></html>`
}

export class MemoryFavoritesStore implements FavoritesStore {
  records = new Map<string, Favorite[]>()
  replacements: string[] = []
  async count(userId: string) { return this.records.get(userId)?.length ?? 0 }
  async replace(userId: string, entries: Favorite[]) {
    this.replacements.push(userId)
    this.records.set(userId, structuredClone(entries))
  }
}

export class FakeImportLogin implements ImportLogin {
  authenticated = false
  visible = false
  logouts = 0
  cleared = 0
  received: BrowserInput[] = []
  private listener: (() => void) | undefined
  status() { return { open: this.visible, authenticated: this.authenticated, width: 1280, height: 800 } }
  async open() { this.visible = true }
  async confirm() { this.authenticated = true; this.visible = false; this.listener?.() }
  invalidate() { this.authenticated = false; this.visible = false }
  async waitForLogin(signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.authenticated) return
    await this.open()
    await new Promise<void>((resolve, reject) => {
      const done = () => { signal.removeEventListener('abort', abort); resolve() }
      const abort = () => { this.listener = undefined; reject(signal.reason) }
      this.listener = done
      signal.addEventListener('abort', abort, { once: true })
      if (this.authenticated) done()
      else if (signal.aborted) abort()
    })
  }
  async input(input: BrowserInput) { this.received.push(input) }
  async screenshot() { return Buffer.from('fake-jpeg') }
  async logout() { this.logouts++; this.authenticated = false; this.visible = false }
  async clear() { this.cleared++; this.authenticated = false; this.visible = false }
  async withPage<T>(): Promise<T> { throw new Error('Fake login has no browser') }
}
