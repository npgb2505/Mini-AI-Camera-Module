import test from 'node:test'
import assert from 'node:assert/strict'
import { getVoiceTtsRouteLabel } from './voice-output-route.js'

test('labels configured VieNeu as server-side TTS', () => {
  assert.equal(getVoiceTtsRouteLabel(true, 'vieneu_self_hosted'), 'VieNeu-TTS trên máy chủ')
})

test('labels another configured provider as server-side TTS', () => {
  assert.equal(getVoiceTtsRouteLabel(true, 'elevenlabs'), 'TTS trên máy chủ')
})

test('labels device speech only when server TTS is unavailable', () => {
  assert.equal(getVoiceTtsRouteLabel(false, 'vieneu_self_hosted'), 'giọng đọc của thiết bị')
})
