import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getPathClientAgeAtResponseMs,
  getPathResultAgeMs,
  isPathResultFresh,
  PATH_RESULT_MAX_AGE_MS,
  pathResponseMatches,
} from './path-result-freshness.js'

test('response age covers phone capture-to-response and server decision age', () => {
  assert.equal(getPathClientAgeAtResponseMs(100, 900, 500), 800)
  assert.equal(getPathClientAgeAtResponseMs(100, 400, 700), 700)
})

test('invalid server age falls back to valid phone-monotonic age', () => {
  for (const serverAge of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(getPathClientAgeAtResponseMs(100, 350, serverAge), 250)
  }
})

test('invalid or regressed phone clock fails closed', () => {
  assert.equal(getPathClientAgeAtResponseMs(Number.NaN, 200, 0), Number.POSITIVE_INFINITY)
  assert.equal(getPathClientAgeAtResponseMs(300, 200, 0), Number.POSITIVE_INFINITY)
})

test('path state stays visible only through the configured freshness boundary', () => {
  const result = { client_age_at_response_ms: 2100 }
  assert.equal(PATH_RESULT_MAX_AGE_MS, 2500)
  assert.equal(getPathResultAgeMs(result, 1000, 1400), 2500)
  assert.equal(isPathResultFresh(result, 1000, 1400), true)
  assert.equal(isPathResultFresh(result, 1000, 1401), false)
  assert.equal(isPathResultFresh(result, 1000, 999), false)
})

test('missing or invalid response age can never appear fresh', () => {
  assert.equal(isPathResultFresh({}, 100, 100), false)
  assert.equal(isPathResultFresh({ client_age_at_response_ms: -1 }, 100, 100), false)
  assert.equal(isPathResultFresh({ client_age_at_response_ms: 0 }, Number.NaN, 100), false)
})

test('a result is accepted only for the expected frame and stream', () => {
  const result = { frame_id: 17, stream_id: 'iphone-session' }
  assert.equal(pathResponseMatches(result, 17, 'iphone-session'), true)
  assert.equal(pathResponseMatches(result, 16, 'iphone-session'), false)
  assert.equal(pathResponseMatches(result, 17, 'other-session'), false)
  assert.equal(pathResponseMatches(null, 17, 'iphone-session'), false)
})
