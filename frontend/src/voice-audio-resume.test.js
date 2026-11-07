import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resumeVoiceAudioContext } from './voice-audio-resume.js'

test('keeps listening blocked until a suspended audio context actually resumes', async () => {
  const context = {
    state: 'suspended',
    async resume() { this.state = 'running' },
  }

  assert.equal(await resumeVoiceAudioContext(context), true)
  assert.equal(context.state, 'running')
})

test('reports failure when audio resume hangs or rejects', async () => {
  const hangingContext = { state: 'suspended', resume: () => new Promise(() => {}) }
  assert.equal(await resumeVoiceAudioContext(hangingContext, 5), false)

  const rejectedContext = { state: 'suspended', resume: async () => { throw new Error('denied') } }
  assert.equal(await resumeVoiceAudioContext(rejectedContext), false)
})

test('accepts an already running context and rejects a closed one', async () => {
  assert.equal(await resumeVoiceAudioContext({ state: 'running' }), true)
  assert.equal(await resumeVoiceAudioContext({ state: 'closed' }), false)
})
