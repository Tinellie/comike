import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { ImageLists, IMAGE_LIST_INTERVAL, MysqlImageListStore } from '../src/social/imageLists.js'
import type { ImageProvider, ListImage } from '../src/social/imageLists.js'
import { db, pool } from '../src/db/index.js'
import { socialImageLists } from '../src/db/schema.js'
import { MemoryImageListStore } from './imageListFixture.js'

const image: ListImage = { id: '12', url: 'https://i.pximg.net/12.png' }
const twitterImage: ListImage = {
  id: '12', url: 'https://pbs.twimg.com/media/12.jpg?name=thumb',
  tweetId: '100', publishedAt: '2026-11-18T00:00:00.000Z', mediaIndex: 0,
}

test('lists remain cached through exactly ten minutes and successful reads do not extend their lifetime', async () => {
  const store = new MemoryImageListStore()
  let time = new Date('2026-11-18T00:00:00.123Z'), calls = 0
  const checkedAt = time
  const fetch = async () => { calls++; return [image] }
  const lists = new ImageLists('pixiv', store, fetch, () => time)
  assert.equal(await lists.needsRefresh('11'), true)
  assert.equal(calls, 0, 'Checking the refresh status must not fetch a list')
  await lists.get('11')
  for (const elapsed of [599_999, 600_000]) {
    time = new Date(checkedAt.getTime() + elapsed)
    assert.equal(await lists.needsRefresh('11'), false)
    assert.equal((await lists.get('11')).refreshed, false)
    assert.equal(calls, 1)
    assert.equal((await store.read('pixiv', '11'))!.checkedAt.getTime(), checkedAt.getTime())
  }
  time = new Date(checkedAt.getTime() + 600_001)
  assert.equal(await lists.needsRefresh('11'), true)
  assert.equal(calls, 1, 'An expired status check still must not start a fetch')
  assert.equal((await lists.get('11')).refreshed, true)
  assert.equal(calls, 2)
})

test('concurrent list consumers share a fetch, including when a previous list expires', async () => {
  const store = new MemoryImageListStore()
  await store.save('pixiv', '11', { checkedAt: new Date(0), images: [] })
  let calls = 0, release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const lists = new ImageLists('pixiv', store, async () => {
    calls++; entered(); await gate; return [image]
  }, () => new Date())
  const first = lists.get('11')
  await started
  const second = lists.get('11')
  release()
  assert.deepEqual((await Promise.all([first, second])).map(list => list.images), [[image], [image]])
  assert.equal(calls, 1)
})

test('new cache instances reuse persisted URLs and empty lists, with separate provider/account keys', async () => {
  const store = new MemoryImageListStore(), time = new Date()
  await new ImageLists('pixiv', store, async () => [image], () => time).get('11')
  await new ImageLists('twitter', store, async () => [], () => time).get('11')
  const unexpected = async (): Promise<ListImage[]> => { throw new Error('Must not fetch again') }
  assert.deepEqual((await new ImageLists('pixiv', store, unexpected, () => time).get('11')).images, [image])
  assert.deepEqual((await new ImageLists('twitter', store, unexpected, () => time).get('11')).images, [])
  assert.equal(await store.read('pixiv', '22'), null)
})

test('failed or malformed list refreshes preserve the old detection time and allow the next request to retry', async () => {
  const store = new MemoryImageListStore(), checkedAt = new Date('2026-11-18T00:00:00Z')
  await store.save('pixiv', '11', { checkedAt, images: [image] })
  let fail = true
  const lists = new ImageLists('pixiv', store, async () => {
    if (fail) throw new Error('List unavailable')
    return []
  }, () => new Date(checkedAt.getTime() + IMAGE_LIST_INTERVAL + 1))
  await assert.rejects(lists.get('11'), /List unavailable/)
  assert.deepEqual(await store.read('pixiv', '11'), { checkedAt, images: [image] })
  fail = false
  assert.deepEqual((await lists.get('11')).images, [])
  const invalid = new ImageLists('pixiv', store, async () => [image, image],
    () => new Date(checkedAt.getTime() + 2 * IMAGE_LIST_INTERVAL + 2))
  await assert.rejects(invalid.get('11'), /重复/)
  assert.deepEqual((await store.read('pixiv', '11'))!.images, [])
})

test('MySQL list snapshots retain millisecond timestamps, URLs, empty lists and Twitter publication metadata across instances',
  { skip: !db && 'Requires server .env' }, async t => {
    t.after(() => pool!.end())
    const artistId = `${Date.now()}99701`
    const checkedAt = new Date('2026-11-18T00:00:00.123Z')
    try {
      for (const provider of ['pixiv', 'twitter'] satisfies ImageProvider[]) {
        const images = provider === 'pixiv' ? [image] : [twitterImage]
        await new MysqlImageListStore().save(provider, artistId, { checkedAt, images })
        assert.deepEqual(await new MysqlImageListStore().read(provider, artistId), { checkedAt, images })
      }
      await new MysqlImageListStore().save('twitter', artistId, { checkedAt, images: [] })
      const lists = new ImageLists('twitter', new MysqlImageListStore(),
        async () => { throw new Error('Restart must reuse persisted empty list') }, () => checkedAt)
      assert.deepEqual((await lists.get(artistId)).images, [])
      assert.deepEqual((await new MysqlImageListStore().read('pixiv', artistId))!.images, [image])
    } finally { await db!.delete(socialImageLists).where(eq(socialImageLists.artist_id, artistId)) }
  })
