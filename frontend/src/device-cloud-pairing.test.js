import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloudDeviceStateLabel, formatDeviceClaimCommand, formatDeviceClaimExpiry, isFreshCloudDeviceEvent } from './device-cloud-pairing.js'

test('one-time claim is presented as the exact USB command and rejects malformed codes', () => {
  const code = `roclaim_${'a'.repeat(43)}`
  assert.equal(formatDeviceClaimCommand(code), `PAIR ${code}`)
  assert.throws(() => formatDeviceClaimCommand('not-a-claim'), /không hợp lệ/)
})

test('claim expiry display is absent for invalid expiry and human-readable for a valid one', () => {
  assert.equal(formatDeviceClaimExpiry(null), '')
  assert.equal(typeof formatDeviceClaimExpiry(Date.UTC(2026, 10, 6, 12, 0)), 'string')
})

test('cloud pairing UI has distinct unpaired, awaiting, connected and stale states', () => {
  assert.equal(cloudDeviceStateLabel('unpaired'), 'ESP32 chưa ghép với tài khoản')
  assert.match(cloudDeviceStateLabel('awaiting_first_telemetry'), /đang chờ ESP32/)
  assert.match(cloudDeviceStateLabel('device_connected'), /đang gửi telemetry/)
  assert.match(cloudDeviceStateLabel('device_stale'), /đã cũ/)
})

test('cloud device event is visible only inside its freshness window', () => {
  const event = { event_id: 'capture-1' }
  assert.equal(isFreshCloudDeviceEvent(event, 29_999), true)
  assert.equal(isFreshCloudDeviceEvent(event, 30_001), false)
  assert.equal(isFreshCloudDeviceEvent(null, 10), false)
})
