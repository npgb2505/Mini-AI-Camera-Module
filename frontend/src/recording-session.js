export function isCurrentRecordedSession(sessionToken, currentToken, recorder, currentRecorder) {
  return recorder != null && sessionToken === currentToken && recorder === currentRecorder
}

export function isRecorderTimerOwnedBy(timer, recorder) {
  return Boolean(timer && recorder != null && timer.recorder === recorder)
}

export function isCurrentRecorderTimer(timer, currentTimer, recorder) {
  return timer != null && currentTimer === timer && isRecorderTimerOwnedBy(timer, recorder)
}

export function isActiveRecordedSession(sessionToken, currentToken, state) {
  return isCurrentVoiceSession(sessionToken, currentToken, state)
}

export function isCurrentVoiceSession(sessionToken, currentToken, state) {
  return sessionToken === currentToken && state !== 'idle' && state !== 'error'
}

export function isCurrentVoiceStartup(sessionToken, currentToken, state) {
  return sessionToken === currentToken && state === 'connecting'
}

export function isCurrentVoiceReadinessOwner(sessionToken, currentToken, state, socket, currentSocket) {
  return isCurrentVoiceStartup(sessionToken, currentToken, state) &&
    socket != null && socket === currentSocket
}
