import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REALTIME_SILENCE_FRAME } from './voice-audio-keepalive.js'
import { RealtimeSpeechGate } from './realtime-speech-gate.js'

function pcmFrame(sample, durationMs = 100) {
  const frame = new Int16Array(durationMs * 16)
  for (let index = 0; index < frame.length; index += 1) frame[index] = index % 2 ? -sample : sample
  return frame.buffer
}

test('forwards speech onset from pre-roll when VAD confirms an utterance', () => {
  const gate = new RealtimeSpeechGate()
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(gate.process(pcmFrame(0)).frames, [REALTIME_SILENCE_FRAME])
  }

  const utteranceFrames = [pcmFrame(7000), pcmFrame(7000), pcmFrame(7000)]
  assert.deepEqual(gate.process(utteranceFrames[0]).frames, [REALTIME_SILENCE_FRAME])
  assert.deepEqual(gate.process(utteranceFrames[1]).frames, [REALTIME_SILENCE_FRAME])
  const confirmed = gate.process(utteranceFrames[2])

  assert.equal(confirmed.speechActive, true)
  assert.equal(confirmed.frames.length, 4)
  assert.deepEqual(confirmed.frames.slice(-3).map((frame) => [...new Int16Array(frame)]),
    utteranceFrames.map((frame) => [...new Int16Array(frame)]))
})

test('silence closes one local speech segment and permits the next utterance', () => {
  const gate = new RealtimeSpeechGate()
  for (let index = 0; index < 5; index += 1) gate.process(pcmFrame(0))
  for (let index = 0; index < 3; index += 1) gate.process(pcmFrame(7000))
  assert.equal(gate.active, true)

  let ended = null
  for (let index = 0; index < 7; index += 1) ended = gate.process(pcmFrame(0))
  assert.equal(ended.speechActive, false)
  assert.deepEqual(gate.process(pcmFrame(0)).frames, [REALTIME_SILENCE_FRAME])

  let nextTurn = null
  const nextUtterance = [pcmFrame(7000), pcmFrame(7000), pcmFrame(7000)]
  for (const frame of nextUtterance) nextTurn = gate.process(frame)
  assert.equal(nextTurn.speechActive, true)
  assert.deepEqual(nextTurn.frames.slice(-3).map((frame) => [...new Int16Array(frame)]),
    nextUtterance.map((frame) => [...new Int16Array(frame)]))
})
