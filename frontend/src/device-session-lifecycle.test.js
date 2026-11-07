import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionOwner, stopMediaStreamIfStale } from './device-session-lifecycle.js'

test('advancing a session owner invalidates work from the prior account or screen', () => {
  const owner = createSessionOwner()
  const oldToken = owner.current()

  assert.equal(owner.owns(oldToken), true)
  const newToken = owner.advance()
  assert.equal(owner.owns(oldToken), false)
  assert.equal(owner.owns(newToken), true)
  assert.equal(owner.owns(Number.NaN), false)
})

test('a microphone stream resolving after its owner expires is stopped immediately', () => {
  const owner = createSessionOwner()
  const token = owner.current()
  const stopped = []
  const stream = { getTracks: () => [{ stop: () => stopped.push(true) }] }

  owner.advance()
  assert.equal(stopMediaStreamIfStale(stream, () => owner.owns(token)), true)
  assert.deepEqual(stopped, [true])
})

test('a current microphone stream is left active for its recorder', () => {
  const owner = createSessionOwner()
  const token = owner.current()
  const stopped = []
  const stream = { getTracks: () => [{ stop: () => stopped.push(true) }] }

  assert.equal(stopMediaStreamIfStale(stream, () => owner.owns(token)), false)
  assert.deepEqual(stopped, [])
})
