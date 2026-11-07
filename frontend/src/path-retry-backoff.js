export const PATH_RETRY_BASE_DELAY_MS = 1000
export const PATH_RETRY_MAX_DELAY_MS = 30000

export function getPathRetryDelayMs(failureCount) {
  const count = Number.isFinite(failureCount)
    ? Math.max(1, Math.trunc(failureCount))
    : 1
  const exponent = Math.min(count - 1, 5)
  return Math.min(PATH_RETRY_BASE_DELAY_MS * (2 ** exponent), PATH_RETRY_MAX_DELAY_MS)
}
