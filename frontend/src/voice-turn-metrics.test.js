import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVoiceTurnTrace,
  formatVoiceLatency,
  markVoiceTurnStage,
  summarizeVoiceTurnTrace,
} from './voice-turn-metrics.js'

test('summarizes recorded voice, transcription, model and first spoken output timings', () => {
  const trace = createVoiceTurnTrace(0)
  const stages = [
    ['recording_started', 1000],
    ['audio_stopped', 4500],
    ['transcription_request_started', 4600],
    ['transcription_response_received', 6200, { transcriptionProvider: 'cloudflare', transcriptionModel: 'whisper-v3' }],
    ['model_request_started', 6400],
    ['model_first_token', 6900],
    ['tts_started', 7150],
    ['model_completed', 8200],
  ]
  stages.forEach(([stage, at, metadata]) => markVoiceTurnStage(trace, stage, at, metadata))

  assert.deepEqual(summarizeVoiceTurnTrace(trace), {
    captureMs: 3500,
    transcriptionRoundTripMs: 1600,
    stopToTranscriptMs: 1700,
    modelFirstTokenMs: 500,
    modelTotalMs: 1800,
    firstTextToSpeechMs: 250,
    stopToFirstSpeechMs: 2650,
    transcriptToFirstSpeechMs: 950,
    transcriptionProvider: 'cloudflare',
    transcriptionModel: 'whisper-v3',
  })
})

test('keeps missing stages unknown instead of reporting zero latency', () => {
  const trace = createVoiceTurnTrace(12)
  assert.equal(summarizeVoiceTurnTrace(trace).stopToFirstSpeechMs, null)
  assert.equal(summarizeVoiceTurnTrace(trace).modelFirstTokenMs, null)
})

test('measures continuous STT turns from final transcript through first spoken output', () => {
  const trace = createVoiceTurnTrace(0)
  markVoiceTurnStage(trace, 'transcription_response_received', 100, {
    transcriptionProvider: 'Safari',
    transcriptionModel: 'Speech Recognition vi-VN',
  })
  markVoiceTurnStage(trace, 'model_request_started', 120)
  markVoiceTurnStage(trace, 'model_first_token', 820)
  markVoiceTurnStage(trace, 'tts_started', 1100)

  const result = summarizeVoiceTurnTrace(trace)
  assert.equal(result.modelFirstTokenMs, 700)
  assert.equal(result.transcriptToFirstSpeechMs, 1000)
  assert.equal(result.stopToFirstSpeechMs, null)
  assert.equal(result.transcriptionProvider, 'Safari')
})

test('rejects unknown, duplicate, invalid and out-of-order timing samples', () => {
  const trace = createVoiceTurnTrace(10)
  assert.equal(markVoiceTurnStage(trace, 'not-a-stage', 11), false)
  assert.equal(markVoiceTurnStage(trace, 'recording_started', Number.NaN), false)
  assert.equal(markVoiceTurnStage(trace, 'recording_started', 9), false)
  assert.equal(markVoiceTurnStage(trace, 'recording_started', 11), true)
  assert.equal(markVoiceTurnStage(trace, 'recording_started', 12), false)
  assert.equal(markVoiceTurnStage(trace, 'audio_stopped', 10), false)
  assert.equal(summarizeVoiceTurnTrace(trace).captureMs, null)
})

test('does not retain transcript or arbitrary metadata fields', () => {
  const trace = createVoiceTurnTrace(0)
  assert.equal(markVoiceTurnStage(trace, 'transcription_response_received', 10, {
    transcriptionProvider: ' cloudflare ',
    transcriptionModel: 'whisper-v3',
    transcript: 'private spoken content',
    apiKey: 'secret',
  }), true)
  assert.deepEqual({ ...trace.metadata }, {
    transcriptionProvider: 'cloudflare',
    transcriptionModel: 'whisper-v3',
  })
})

test('formats measured seconds and labels unavailable values honestly', () => {
  assert.equal(formatVoiceLatency(1250), '1.25 giây')
  assert.equal(formatVoiceLatency(null), 'chưa đo')
  assert.equal(formatVoiceLatency(-1), 'chưa đo')
})
