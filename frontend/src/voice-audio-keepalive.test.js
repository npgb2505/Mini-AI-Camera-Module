import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  REALTIME_SILENCE_FRAME,
  REALTIME_SILENCE_KEEPALIVE_MS,
  realtimeAudioFrameForState,
} from './voice-audio-keepalive.js'

test('forwards microphone audio only while listening', () => {
  assert.equal(realtimeAudioFrameForState({ state: 'listening' }), 'microphone')
  assert.equal(realtimeAudioFrameForState({ state: 'connecting', assistantSpeaking: false }), null)
})

test('sends sparse silence during assistant output to keep realtime STT alive', () => {
  const firstKeepaliveAt = 9000
  assert.equal(realtimeAudioFrameForState({
    state: 'speaking', assistantSpeaking: true, nowMs: firstKeepaliveAt, lastKeepaliveAtMs: 4000,
  }), 'silence')
  assert.equal(realtimeAudioFrameForState({
    state: 'resuming', assistantSpeaking: true,
    nowMs: firstKeepaliveAt + REALTIME_SILENCE_KEEPALIVE_MS - 1,
    lastKeepaliveAtMs: firstKeepaliveAt,
  }), null)
  assert.equal(realtimeAudioFrameForState({
    state: 'speaking', assistantSpeaking: true,
    nowMs: firstKeepaliveAt + REALTIME_SILENCE_KEEPALIVE_MS,
    lastKeepaliveAtMs: firstKeepaliveAt,
  }), 'silence')
  assert.equal(REALTIME_SILENCE_FRAME.byteLength, 3200)
})

test('does not keepalive after assistant output ends', () => {
  assert.equal(realtimeAudioFrameForState({
    state: 'speaking', assistantSpeaking: false, nowMs: 10000, lastKeepaliveAtMs: 0,
  }), null)
})
