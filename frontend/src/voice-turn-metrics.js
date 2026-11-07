const STAGES = new Set([
  'recording_started',
  'audio_stopped',
  'transcription_request_started',
  'transcription_response_received',
  'model_request_started',
  'model_first_token',
  'model_completed',
  'tts_started',
])

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now()
}

function safeLabel(value) {
  if (typeof value !== 'string') return null
  const clean = value.trim().slice(0, 100)
  return clean || null
}

export function createVoiceTurnTrace(startedAt = monotonicNow()) {
  return {
    startedAt: Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : null,
    stages: Object.create(null),
    metadata: Object.create(null),
  }
}

export function markVoiceTurnStage(trace, stage, at = monotonicNow(), metadata = {}) {
  if (!trace || !STAGES.has(stage) || !Number.isFinite(at) || at < 0) return false
  if (trace.startedAt === null || at < trace.startedAt || Object.hasOwn(trace.stages, stage)) return false

  const previousTimes = Object.values(trace.stages)
  if (previousTimes.length && at < Math.max(...previousTimes)) return false

  trace.stages[stage] = at
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    for (const key of ['transcriptionProvider', 'transcriptionModel']) {
      const label = safeLabel(metadata[key])
      if (label) trace.metadata[key] = label
    }
  }
  return true
}

export function summarizeVoiceTurnTrace(trace) {
  const stages = trace?.stages || {}
  const duration = (start, end) => {
    const from = stages[start]
    const to = stages[end]
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
    return Math.round(to - from)
  }

  return {
    captureMs: duration('recording_started', 'audio_stopped'),
    transcriptionRoundTripMs: duration('transcription_request_started', 'transcription_response_received'),
    stopToTranscriptMs: duration('audio_stopped', 'transcription_response_received'),
    transcriptToFirstSpeechMs: duration('transcription_response_received', 'tts_started'),
    modelFirstTokenMs: duration('model_request_started', 'model_first_token'),
    modelTotalMs: duration('model_request_started', 'model_completed'),
    firstTextToSpeechMs: duration('model_first_token', 'tts_started'),
    stopToFirstSpeechMs: duration('audio_stopped', 'tts_started'),
    transcriptionProvider: trace?.metadata?.transcriptionProvider || null,
    transcriptionModel: trace?.metadata?.transcriptionModel || null,
  }
}

export function formatVoiceLatency(value) {
  if (!Number.isFinite(value) || value < 0) return 'chưa đo'
  return `${(value / 1000).toFixed(2)} giây`
}
