import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isActiveRecordedSession,
  isCurrentRecordedSession,
  isCurrentRecorderTimer,
  isCurrentVoiceSession,
  isCurrentVoiceReadinessOwner,
  isCurrentVoiceStartup,
  isRecorderTimerOwnedBy,
} from './recording-session.js'

test('a stop callback belongs only to its active token and recorder', () => {
  const recorder = {}
  assert.equal(isCurrentRecordedSession(4, 4, recorder, recorder), true)
})

test('a callback from an older recording token is stale', () => {
  const recorder = {}
  assert.equal(isCurrentRecordedSession(4, 5, recorder, recorder), false)
})

test('a callback cannot own a recorder replaced by a newer session', () => {
  assert.equal(isCurrentRecordedSession(4, 4, {}, {}), false)
  assert.equal(isCurrentRecordedSession(4, 4, null, null), false)
})

test('a stale recorder cannot clear or fire a newer recorder timer', () => {
  const staleRecorder = {}
  const activeRecorder = {}
  const activeTimer = { id: 9, recorder: activeRecorder }
  const staleTimer = { id: 8, recorder: staleRecorder }

  assert.equal(isRecorderTimerOwnedBy(activeTimer, staleRecorder), false)
  assert.equal(isCurrentRecorderTimer(staleTimer, activeTimer, staleRecorder), false)
  assert.equal(isRecorderTimerOwnedBy(activeTimer, activeRecorder), true)
  assert.equal(isCurrentRecorderTimer(activeTimer, activeTimer, activeRecorder), true)
})

test('async work belongs only to the active recorded session', () => {
  assert.equal(isActiveRecordedSession(4, 4, 'transcribing'), true)
  assert.equal(isActiveRecordedSession(4, 4, 'idle'), false)
  assert.equal(isActiveRecordedSession(4, 4, 'error'), false)
  assert.equal(isActiveRecordedSession(4, 5, 'connecting'), false)
})

test('realtime callbacks belong only to the current active voice session', () => {
  for (const state of ['connecting', 'listening', 'speaking', 'recording', 'transcribing']) {
    assert.equal(isCurrentVoiceSession(6, 6, state), true)
  }
  assert.equal(isCurrentVoiceSession(5, 6, 'connecting'), false)
  assert.equal(isCurrentVoiceSession(6, 6, 'idle'), false)
  assert.equal(isCurrentVoiceSession(6, 6, 'error'), false)
})

test('voice startup callbacks are valid only while their own session connects', () => {
  assert.equal(isCurrentVoiceStartup(6, 6, 'connecting'), true)
  assert.equal(isCurrentVoiceStartup(5, 6, 'connecting'), false)
  assert.equal(isCurrentVoiceStartup(6, 6, 'listening'), false)
  assert.equal(isCurrentVoiceStartup(6, 6, 'idle'), false)
})

test('session-ready timeout belongs only to its connecting session and socket', () => {
  const socket = {}
  assert.equal(isCurrentVoiceReadinessOwner(6, 6, 'connecting', socket, socket), true)
  assert.equal(isCurrentVoiceReadinessOwner(5, 6, 'connecting', socket, socket), false)
  assert.equal(isCurrentVoiceReadinessOwner(6, 6, 'listening', socket, socket), false)
  assert.equal(isCurrentVoiceReadinessOwner(6, 6, 'connecting', socket, {}), false)
  assert.equal(isCurrentVoiceReadinessOwner(6, 6, 'connecting', null, null), false)
})
