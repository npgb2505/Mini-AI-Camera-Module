import assert from 'node:assert/strict'
import test from 'node:test'
import { getPathRetryDelayMs } from './path-retry-backoff.js'

test('path inference retry delay grows exponentially and caps at 30 seconds', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(getPathRetryDelayMs),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  )
})

test('missing, invalid, or non-positive failure counts use the first retry delay', () => {
  for (const count of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -2]) {
    assert.equal(getPathRetryDelayMs(count), 1000)
  }
})
