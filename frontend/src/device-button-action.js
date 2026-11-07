export function shouldClaimCloudAskButtonEvent(transport, event) {
  return transport === 'cloud_uplink'
    && event?.button_id === 'ask_llm'
    && event?.action === 'pressed'
    && typeof event.event_id === 'string'
    && /^[A-Za-z0-9_-]{1,96}$/.test(event.event_id)
}

export function shouldUseDeviceBrowserSpeechRecognition(transport, speechRecognitionAvailable) {
  return transport !== 'cloud_uplink' && Boolean(speechRecognitionAvailable)
}

export function createPendingDeviceButtonAction({
  event,
  eventAgeMs,
  operationEnabled,
  frameSeq,
  receivedAt,
}) {
  if (!event || typeof event !== 'object') return null
  if (!['capture_image', 'ask_llm'].includes(event.button_id) || event.action !== 'pressed') return null
  if (operationEnabled !== true || event.operation_enabled !== true) return null
  if (!Number.isInteger(eventAgeMs) || eventAgeMs < 0 || eventAgeMs > 10000) return null
  if (typeof event.device_id !== 'string' || !event.device_id.trim()) return null
  if (typeof event.boot_id !== 'string' || !event.boot_id.trim()) return null
  if (!Number.isInteger(event.press_id) || event.press_id < 1 || event.press_id > 4294967295) return null

  return {
    key: JSON.stringify([event.device_id, event.boot_id, event.press_id]),
    action: event.button_id,
    frameSeq: Number.isInteger(frameSeq) && frameSeq > 0 ? frameSeq : undefined,
    eventAgeMs,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : 0,
  }
}
