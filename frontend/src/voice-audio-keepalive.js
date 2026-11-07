export const REALTIME_SILENCE_KEEPALIVE_MS = 5000
export const REALTIME_SILENCE_FRAME = new ArrayBuffer(1600 * Int16Array.BYTES_PER_ELEMENT)

export function realtimeAudioFrameForState({ state, assistantSpeaking, nowMs, lastKeepaliveAtMs }) {
  if (state === 'listening') return 'microphone'
  if (!assistantSpeaking || !['speaking', 'resuming'].includes(state)) return null
  if (nowMs - lastKeepaliveAtMs < REALTIME_SILENCE_KEEPALIVE_MS) return null
  return 'silence'
}
