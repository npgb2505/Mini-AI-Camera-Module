import assert from 'node:assert/strict'
import test from 'node:test'
import { isFreshDeviceFusion } from './device-fusion-freshness.js'

function fixture(overrides = {}) {
  const status = {
    source: 'device',
    camera_input_state: 'live',
    camera_frame: 42,
    tof_mode: 'device',
    tof_ok: true,
    tof_boot_id: 'boot-a',
    tof_frame_seq: 42,
    zones: [
      { zone: 'left', tof_valid: false, nearest_cm: null },
      { zone: 'center', tof_valid: true, nearest_cm: 65.2 },
      { zone: 'right', tof_valid: false, nearest_cm: null },
    ],
    device_health: { device_id: 'device-a', boot_id: 'boot-a' },
    corridor_decision: {
      type: 'corridor_decision',
      origin: 'device',
      device_id: 'device-a',
      boot_id: 'boot-a',
      frame_seq: 42,
      tof_seq: 101,
      input_origins: ['device'],
      risk: 'caution',
      recommended_zone: 'center',
      lanes: [
        { zone: 'left', tof_valid: false, nearest_mm: null, camera_valid: true, camera_blocked: false, status: 'open' },
        { zone: 'center', tof_valid: true, nearest_mm: 652, camera_valid: true, camera_blocked: false, status: 'caution' },
        { zone: 'right', tof_valid: false, nearest_mm: null, camera_valid: true, camera_blocked: false, status: 'open' },
      ],
    },
    ...overrides.status,
  }
  return {
    transport: 'firmware_wifi',
    linked: true,
    operationReady: true,
    status,
    cameraAgeMs: 120,
    cameraTtlMs: 350,
    tofAgeMs: 180,
    tofTtlMs: 350,
    detectionFrameSeq: 42,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'status')),
  }
}

test('accepts a current fusion decision with a matching frame, boot and validated ToF lane', () => {
  assert.equal(isFreshDeviceFusion(fixture()), true)
})

test('rejects fusion from cloud telemetry because it has no camera decision event', () => {
  assert.equal(isFreshDeviceFusion(fixture({ transport: 'cloud_uplink' })), false)
})

test('rejects missing, stale, disabled or boot-mismatched ToF', () => {
  assert.equal(isFreshDeviceFusion(fixture({ status: { tof_ok: false } })), false)
  assert.equal(isFreshDeviceFusion(fixture({ tofAgeMs: 351 })), false)
  assert.equal(isFreshDeviceFusion(fixture({ status: { tof_boot_id: 'boot-old' } })), false)
  assert.equal(isFreshDeviceFusion(fixture({ status: { zones: [] } })), false)
})

test('keeps a camera-backed stop alert while ToF is unavailable, but never accepts clear', () => {
  const status = {
    source: 'device',
    camera_input_state: 'live',
    camera_frame: 42,
    device_id: 'device-a',
    boot_id: 'boot-a',
    device_health: { device_id: 'device-a', boot_id: 'boot-a' },
    tof_mode: 'unknown',
    tof_ok: false,
    tof_age_ms: null,
    tof_boot_id: null,
    tof_frame_seq: null,
    zones: [],
    corridor_decision: {
      type: 'corridor_decision', origin: 'device', device_id: 'device-a', boot_id: 'boot-a',
      frame_seq: 42, tof_seq: null, input_origins: ['device'], risk: 'stop', recommended_zone: 'center',
      lanes: [
        { zone: 'left', tof_valid: false, nearest_mm: null, camera_valid: true, camera_blocked: false, status: 'open' },
        { zone: 'center', tof_valid: false, nearest_mm: null, camera_valid: true, camera_blocked: true, status: 'blocked' },
        { zone: 'right', tof_valid: false, nearest_mm: null, camera_valid: true, camera_blocked: false, status: 'open' },
      ],
    },
  }
  assert.equal(isFreshDeviceFusion(fixture({ status })), true)
  assert.equal(isFreshDeviceFusion(fixture({ status: {
    ...status,
    corridor_decision: { ...status.corridor_decision, risk: 'clear' },
  } })), false)
})

test('rejects camera, detection or corridor frame mismatch', () => {
  assert.equal(isFreshDeviceFusion(fixture({ status: { camera_frame: 43 } })), false)
  assert.equal(isFreshDeviceFusion(fixture({ detectionFrameSeq: 41 })), false)
  assert.equal(isFreshDeviceFusion(fixture({ status: { corridor_decision: { frame_seq: 41 } } })), false)
})

test('rejects invalid lane shape, sequence, device identity or risk value', () => {
  assert.equal(isFreshDeviceFusion(fixture({ status: { corridor_decision: { tof_seq: null } } })), false)
  assert.equal(isFreshDeviceFusion(fixture({ status: { corridor_decision: { device_id: 'other' } } })), false)
  assert.equal(isFreshDeviceFusion(fixture({ status: { corridor_decision: { risk: 'safe' } } })), false)
  assert.equal(isFreshDeviceFusion(fixture({ status: { corridor_decision: { lanes: [] } } })), false)
})
