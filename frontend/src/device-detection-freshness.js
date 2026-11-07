export const DEVICE_DETECTION_DISPLAY_TTL_MS = 750

export function isDeviceDetectionAgeFresh(ageMs) {
  return Number.isFinite(ageMs)
    && ageMs >= 0
    && ageMs <= DEVICE_DETECTION_DISPLAY_TTL_MS
}

export function deviceDetectionMatchesFrame(detectionFrameSeq, previewFrameSeq) {
  return Number.isInteger(detectionFrameSeq)
    && detectionFrameSeq > 0
    && Number.isInteger(previewFrameSeq)
    && previewFrameSeq > 0
    && detectionFrameSeq === previewFrameSeq
}
