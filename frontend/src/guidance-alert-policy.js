export const GUIDANCE_STATES = Object.freeze(['left', 'center', 'right', 'stop', 'unknown'])
export const GUIDANCE_HISTORY_SIZE = 5
export const GUIDANCE_STABLE_COUNT = 3
export const GUIDANCE_DIRECTION_COOLDOWN_MS = 1800

export const GUIDANCE_VIBRATION_PATTERNS = Object.freeze({
  left: Object.freeze([80, 65, 80]),
  center: Object.freeze([55]),
  right: Object.freeze([80, 65, 180]),
  stop: Object.freeze([180, 90, 180]),
})

export function appendGuidanceState(history, state) {
  if (!GUIDANCE_STATES.includes(state)) return history
  return [...history, state].slice(-GUIDANCE_HISTORY_SIZE)
}

export function isGuidanceStable(history, state) {
  return GUIDANCE_STATES.includes(state)
    && history.filter((item) => item === state).length >= GUIDANCE_STABLE_COUNT
}

export function getGuidanceCue({
  state,
  lastCue,
  now,
  canSpeak,
  canVibrate,
  cooldownMs = GUIDANCE_DIRECTION_COOLDOWN_MS,
}) {
  if (!GUIDANCE_VIBRATION_PATTERNS[state]) return null
  if (lastCue?.state === state || (!canSpeak && !canVibrate)) return null
  if (state !== 'stop' && now - (lastCue?.at ?? 0) < cooldownMs) return null
  return {
    state,
    speak: Boolean(canSpeak),
    vibrate: Boolean(canVibrate),
    vibrationPattern: canVibrate ? GUIDANCE_VIBRATION_PATTERNS[state] : null,
  }
}
