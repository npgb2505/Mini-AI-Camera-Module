import test from 'node:test'
import assert from 'node:assert/strict'
import { getVoiceReadiness } from './voice-capability.js'

test('realtime server STT enables voice even without recorded fallback', () => {
  assert.deepEqual(getVoiceReadiness({ voice_realtime_ready: true }), {
    realtimeReady: true,
    recordedServerReady: false,
    ready: true,
    mode: 'realtime',
  })
})

test('recorded server STT enables voice when its fallback route is ready', () => {
  assert.equal(getVoiceReadiness({
    transcription_ready: true,
    voice_browser_fallback_ready: true,
  }).mode, 'recorded')
})

test('browser fallback flag alone does not claim server voice is ready', () => {
  assert.deepEqual(getVoiceReadiness({ voice_browser_fallback_ready: true }), {
    realtimeReady: false,
    recordedServerReady: false,
    ready: false,
    mode: 'unavailable',
  })
})

test('transcription provider without recorded voice route is not advertised as ready', () => {
  assert.equal(getVoiceReadiness({ transcription_ready: true }).ready, false)
})
