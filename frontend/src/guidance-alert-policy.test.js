import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendGuidanceState,
  getGuidanceCue,
  GUIDANCE_VIBRATION_PATTERNS,
  isGuidanceStable,
} from './guidance-alert-policy.js'

test('a direction needs three matching states in the latest five frames', () => {
  let history = []
  for (const state of ['left', 'right', 'left', 'center']) {
    history = appendGuidanceState(history, state)
  }
  assert.equal(isGuidanceStable(history, 'left'), false)
  history = appendGuidanceState(history, 'left')
  assert.equal(isGuidanceStable(history, 'left'), true)
  assert.equal(isGuidanceStable(history, 'unknown'), false)
})

test('invalid predictions do not enter the stability history', () => {
  const history = ['left', 'right']
  assert.equal(appendGuidanceState(history, 'invalid'), history)
})

test('left, center, right and stop have distinct vibration cues', () => {
  const patterns = Object.values(GUIDANCE_VIBRATION_PATTERNS).map((pattern) => pattern.join(','))
  assert.equal(new Set(patterns).size, 4)
})

test('a cue emits only on a stable-state transition and direction cooldown', () => {
  assert.equal(getGuidanceCue({ state: 'left', lastCue: { state: 'left', at: 5000 }, now: 9000, canSpeak: true, canVibrate: true }), null)
  assert.equal(getGuidanceCue({ state: 'right', lastCue: { state: 'left', at: 5000 }, now: 6000, canSpeak: true, canVibrate: true }), null)
  const cue = getGuidanceCue({ state: 'right', lastCue: { state: 'left', at: 5000 }, now: 6800, canSpeak: true, canVibrate: true })
  assert.equal(cue.state, 'right')
  assert.equal(cue.speak, true)
  assert.equal(cue.vibrate, true)
  assert.deepEqual(cue.vibrationPattern, [80, 65, 180])
})

test('a stable stop cue bypasses direction cooldown; unavailable haptics do not claim vibration', () => {
  const stop = getGuidanceCue({ state: 'stop', lastCue: { state: 'left', at: 9900 }, now: 10000, canSpeak: false, canVibrate: true })
  assert.equal(stop.vibrate, true)
  assert.equal(stop.speak, false)
  const spokenOnly = getGuidanceCue({ state: 'center', lastCue: { state: 'left', at: 1000 }, now: 5000, canSpeak: true, canVibrate: false })
  assert.equal(spokenOnly.vibrate, false)
  assert.equal(spokenOnly.vibrationPattern, null)
})

test('nothing is announced when the browser has neither speech nor vibration', () => {
  assert.equal(getGuidanceCue({ state: 'center', lastCue: { state: '', at: 0 }, now: 5000, canSpeak: false, canVibrate: false }), null)
})

test('unknown guidance never produces an alert cue', () => {
  assert.equal(getGuidanceCue({ state: 'unknown', lastCue: null, now: 5000, canSpeak: true, canVibrate: true }), null)
})
