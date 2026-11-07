export function isActiveCurrentCameraStream(stream, currentStream, active) {
  return Boolean(stream && stream === currentStream && active)
}

export function shouldHandleCameraTrackEnd(stream, currentStream, active) {
  return isActiveCurrentCameraStream(stream, currentStream, active)
}
