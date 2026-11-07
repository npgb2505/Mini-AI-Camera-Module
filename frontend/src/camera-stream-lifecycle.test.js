import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isActiveCurrentCameraStream,
  shouldHandleCameraTrackEnd,
} from './camera-stream-lifecycle.js'

test('handles an ended track only for the active current stream', () => {
  const current = {}
  assert.equal(shouldHandleCameraTrackEnd(current, current, true), true)
  assert.equal(shouldHandleCameraTrackEnd({}, current, true), false)
  assert.equal(shouldHandleCameraTrackEnd(current, current, false), false)
  assert.equal(shouldHandleCameraTrackEnd(null, current, true), false)
})

test('an older camera loop cannot own or update a replacement stream', () => {
  const oldStream = {}
  const currentStream = {}
  assert.equal(isActiveCurrentCameraStream(oldStream, currentStream, true), false)
  assert.equal(isActiveCurrentCameraStream(currentStream, currentStream, true), true)
  assert.equal(isActiveCurrentCameraStream(currentStream, currentStream, false), false)
})
