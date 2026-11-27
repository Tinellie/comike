import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapRotationFromOrientation } from '../../client/src/map/basemap/deviceHeading.ts'

const absolute = { alpha: 0, beta: 0, gamma: 0, absolute: true }

test('absolute orientation aligns compass directions and screen rotation', () => {
  const closeTo = (actual: number | null, expected: number) => {
    assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} should be ${expected}`)
  }
  closeTo(mapRotationFromOrientation(absolute, 0), 0)
  closeTo(mapRotationFromOrientation({ ...absolute, alpha: 90 }, 0), 90)
  closeTo(mapRotationFromOrientation({ ...absolute, alpha: 270 }, 0), -90)
  closeTo(mapRotationFromOrientation(absolute, 90), -90)
  closeTo(mapRotationFromOrientation(absolute, 180), -180)
  closeTo(mapRotationFromOrientation({ ...absolute, alpha: 90, beta: 45 }, 0), 90)
  closeTo(mapRotationFromOrientation({ ...absolute, gamma: 45 }, 90), -90)
  closeTo(mapRotationFromOrientation({ ...absolute, beta: 60, gamma: 30 }, 90), -63.43494882292201)
})

test('WebKit compass heading and screen angle determine map rotation', () => {
  assert.equal(mapRotationFromOrientation({ ...absolute, absolute: false, webkitCompassHeading: 90 }, 0), -90)
  assert.equal(mapRotationFromOrientation({ ...absolute, absolute: false, webkitCompassHeading: 90 }, 90), -180)
})

test('rejects relative, invalid and vertically ambiguous directions', () => {
  assert.equal(mapRotationFromOrientation({ ...absolute, absolute: false }, 0), null)
  assert.equal(mapRotationFromOrientation({ ...absolute, absolute: false, webkitCompassHeading: 90,
    webkitCompassAccuracy: -1 }, 0), null)
  assert.equal(mapRotationFromOrientation({ ...absolute, alpha: null }, 0), null)
  assert.equal(mapRotationFromOrientation({ ...absolute, beta: 90 }, 0), null)
})
