export const PATH_RESULT_MAX_AGE_MS = 2500

export function pathResponseMatches(result, expectedFrameId, expectedStreamId) {
  return Boolean(
    result && typeof result === 'object' &&
    result.frame_id === expectedFrameId &&
    result.stream_id === expectedStreamId
  )
}

export function getPathClientAgeAtResponseMs(capturedAt, responseAt, serverDecisionAgeMs) {
  if (!Number.isFinite(capturedAt) || !Number.isFinite(responseAt) || responseAt < capturedAt) {
    return Number.POSITIVE_INFINITY
  }
  const clientTripAgeMs = Math.max(0, Math.round(responseAt - capturedAt))
  const serverAgeMs = Number.isFinite(serverDecisionAgeMs) && serverDecisionAgeMs >= 0
    ? serverDecisionAgeMs
    : 0
  return Math.max(clientTripAgeMs, serverAgeMs)
}

export function getPathResultAgeMs(result, responseAt, now) {
  const ageAtResponseMs = Number.isFinite(result?.client_age_at_response_ms)
    && result.client_age_at_response_ms >= 0
    ? result.client_age_at_response_ms
    : Number.POSITIVE_INFINITY
  if (!Number.isFinite(responseAt) || !Number.isFinite(now) || now < responseAt) {
    return Number.POSITIVE_INFINITY
  }
  return ageAtResponseMs + now - responseAt
}

export function isPathResultFresh(result, responseAt, now, maxAgeMs = PATH_RESULT_MAX_AGE_MS) {
  const ageMs = getPathResultAgeMs(result, responseAt, now)
  return Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && ageMs >= 0 && ageMs <= maxAgeMs
}
