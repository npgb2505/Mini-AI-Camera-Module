import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VoiceSpeechStartGate } from './voice-speech-start.js'

test('starts capture on the first voiced frame and confirms the same candidate', () => {
  const gate = new VoiceSpeechStartGate(4)
  assert.deepEqual(gate.process(true, false, 1000), { action: 'start', startedAt: 1000 })
  assert.deepEqual(gate.process(true, true, 1050), { action: 'none', startedAt: 1000 })
  assert.deepEqual(gate.process(true, true, 1100), { action: 'none', startedAt: 1000 })
  assert.deepEqual(gate.process(true, true, 1150), { action: 'confirm', startedAt: 1000 })
  assert.deepEqual(gate.process(true, true, 1200), { action: 'confirmed', startedAt: 1000 })
})

test('cancels a short noise candidate before it becomes a transcript turn', () => {
  const gate = new VoiceSpeechStartGate(4)
  assert.equal(gate.process(true, false, 1000).action, 'start')
  assert.equal(gate.process(true, true, 1050).action, 'none')
  assert.deepEqual(gate.process(false, true, 1100), { action: 'cancel', startedAt: 0 })
  assert.equal(gate.process(true, false, 1200).action, 'start')
})
