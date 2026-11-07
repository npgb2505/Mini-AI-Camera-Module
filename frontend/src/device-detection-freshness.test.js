import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEVICE_DETECTION_DISPLAY_TTL_MS,
  deviceDetectionMatchesFrame,
  isDeviceDetectionAgeFresh,
} from './device-detection-freshness.js'

test('device detections remain display-fresh through the measured frame interval', () => {
  assert.equal(DEVICE_DETECTION_DISPLAY_TTL_MS, 750)
  assert.equal(isDeviceDetectionAgeFresh(640), true)
  assert.equal(isDeviceDetectionAgeFresh(750), true)
  assert.equal(isDeviceDetectionAgeFresh(751), false)
  assert.equal(isDeviceDetectionAgeFresh(-1), false)
  assert.equal(isDeviceDetectionAgeFresh(Number.NaN), false)
})

test('device detections can overlay only their exact JPEG frame', () => {
  assert.equal(deviceDetectionMatchesFrame(48, 48), true)
  assert.equal(deviceDetectionMatchesFrame(48, 49), false)
  assert.equal(deviceDetectionMatchesFrame(0, 0), false)
  assert.equal(deviceDetectionMatchesFrame(Number.NaN, 48), false)
})
