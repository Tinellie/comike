import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { mapSlots, missingSlots } from '../src/booths/reconcile.js'

function mapData() {
  return { halls: [{ name: '東123', islands: [{ code: 'ア', blocks: [{ booths: [
    { id: 'm1', number: '1', split: { a: 'r', b: 'l' } },
    { id: 'm2', number: '02', split: { a: 't', b: 'b' } },
  ] }] }] }] }
}

test('map vacancy projection validates map positions and preserves both half-booths', () => {
  const slots = mapSlots(mapData())
  assert.deepEqual(slots.map(slot => [slot.booth_number, slot.booth_suffix]), [['01', 'a'], ['01', 'b'], ['02', 'a'], ['02', 'b']])
  const data = mapData()
  data.halls[0]!.islands[0]!.blocks[0]!.booths.push(data.halls[0]!.islands[0]!.blocks[0]!.booths[0]!)
  assert.throws(() => mapSlots(data), /重复/)
  const invalid = mapData()
  invalid.halls[0]!.islands[0]!.blocks[0]!.booths[0]!.split.b = 'r'
  assert.throws(() => mapSlots(invalid), /分割/)
})

const actualMap = new URL('../../tools/booth-recognition/output/official-map/final.json', import.meta.url)
test('actual locally generated map contains all expected half-booths',
  { skip: !existsSync(actualMap) && 'Local OCR output is not included in Git or CI' }, async () => {
  const actual = mapSlots(JSON.parse(await readFile(actualMap, 'utf8')))
  assert.equal(actual.length, 11202)
})

test('vacancies compare every day independently; a/b cover one half and ab covers both', () => {
  const slots = mapSlots(mapData())
  const circle = { weekday: '土', hall: '東', island_code: 'ア', booth_number: '01', booth_suffix: 'a' }
  assert.deepEqual(missingSlots(slots, [circle]).map(slot => `${slot.booth_number}${slot.booth_suffix}`), ['01b', '02a', '02b'])
  assert.deepEqual(missingSlots(slots, [{ ...circle, booth_suffix: 'b' }]).map(slot => `${slot.booth_number}${slot.booth_suffix}`), ['01a', '02a', '02b'])
  assert.deepEqual(missingSlots(slots, [{ ...circle, booth_suffix: 'ab' }]).map(slot => `${slot.booth_number}${slot.booth_suffix}`), ['02a', '02b'])
  for (const suffix of ['', null]) assert.equal(missingSlots(slots, [{ ...circle, booth_suffix: suffix }]).length, 4)
  const days = missingSlots(slots, [circle, { ...circle, weekday: '日', booth_suffix: 'ab' }])
  assert.equal(days.filter(slot => slot.weekday === '土').length, 3)
  assert.equal(days.filter(slot => slot.weekday === '日').length, 2)
  assert.equal(missingSlots(slots, [{ ...circle, island_code: 'あ' }]).length, 4)
  assert.throws(() => missingSlots(slots, [{ ...circle, booth_suffix: 'x' }]), /后缀/)
  assert.deepEqual(missingSlots(slots, []), [])
})
