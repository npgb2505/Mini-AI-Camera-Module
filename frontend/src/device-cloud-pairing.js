export function formatDeviceClaimCommand(claimCode) {
  if (typeof claimCode !== 'string' || !/^roclaim_[A-Za-z0-9_-]{43}$/.test(claimCode)) {
    throw new TypeError('Mã ghép ESP32 không hợp lệ.')
  }
  return `PAIR ${claimCode}`
}

export function formatDeviceClaimExpiry(expiresAtMs) {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return ''
  return new Date(expiresAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function cloudDeviceStateLabel(state) {
  if (state === 'awaiting_first_telemetry') return 'Đã ghép · đang chờ ESP32 gửi telemetry'
  if (state === 'device_connected') return 'ESP32 đang gửi telemetry qua cloud'
  if (state === 'device_stale') return 'Đã ghép · telemetry ESP32 đã cũ'
  return 'ESP32 chưa ghép với tài khoản'
}

export function isFreshCloudDeviceEvent(event, ageMs) {
  return Boolean(event && typeof event.event_id === 'string'
    && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 30_000)
}
