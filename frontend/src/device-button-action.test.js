import test from 'node:test'
import assert from 'node:assert/strict'
import { createPendingDeviceButtonAction, shouldClaimCloudAskButtonEvent, shouldUseDeviceBrowserSpeechRecognition } from './device-button-action.js'

const validEvent = {
  type: 'button_event',
  button_id: 'capture_image',
  action: 'pressed',
  device_id: 'cam-01',
  boot_id: 'boot-abc',
  press_id: 7,
  operation_enabled: true,
}

test('claims only fresh-shaped cloud Ask presses, not local events or capture events', () => {
  const cloudAsk = { ...validEvent, button_id: 'ask_llm', event_id: 'cam-01-boot-abc-7' }
  assert.equal(shouldClaimCloudAskButtonEvent('cloud_uplink', cloudAsk), true)
  assert.equal(shouldClaimCloudAskButtonEvent('firmware_wifi', cloudAsk), false)
  assert.equal(shouldClaimCloudAskButtonEvent('cloud_uplink', validEvent), false)
  assert.equal(shouldClaimCloudAskButtonEvent('cloud_uplink', { ...cloudAsk, action: 'released' }), false)
  assert.equal(shouldClaimCloudAskButtonEvent('cloud_uplink', { ...cloudAsk, event_id: '../bad' }), false)
})

test('queues a fresh active capture event and carries the current frame sequence', () => {
  assert.deepEqual(createPendingDeviceButtonAction({
    event: validEvent,
    eventAgeMs: 24,
    operationEnabled: true,
    frameSeq: 123,
    receivedAt: 1000,
  }), {
    key: '["cam-01","boot-abc",7]',
    action: 'capture_image',
    frameSeq: 123,
    eventAgeMs: 24,
    receivedAt: 1000,
  })
})

test('queues a fresh active ask event', () => {
  const action = createPendingDeviceButtonAction({
    event: { ...validEvent, button_id: 'ask_llm' },
    eventAgeMs: 0,
    operationEnabled: true,
    receivedAt: 50,
  })
  assert.equal(action?.action, 'ask_llm')
  assert.equal(action?.frameSeq, undefined)
})

test('does not queue events while the board or event says standby', () => {
  assert.equal(createPendingDeviceButtonAction({ event: validEvent, eventAgeMs: 2, operationEnabled: false }), null)
  assert.equal(createPendingDeviceButtonAction({ event: { ...validEvent, operation_enabled: false }, eventAgeMs: 2, operationEnabled: true }), null)
  assert.equal(createPendingDeviceButtonAction({ event: validEvent, eventAgeMs: 2, operationEnabled: null }), null)
})

test('rejects stale and malformed event records', () => {
  assert.equal(createPendingDeviceButtonAction({ event: validEvent, eventAgeMs: 10001, operationEnabled: true }), null)
  assert.equal(createPendingDeviceButtonAction({ event: { ...validEvent, action: 'released' }, eventAgeMs: 2, operationEnabled: true }), null)
  assert.equal(createPendingDeviceButtonAction({ event: { ...validEvent, press_id: 0 }, eventAgeMs: 2, operationEnabled: true }), null)
  assert.equal(createPendingDeviceButtonAction({ event: { ...validEvent, boot_id: '' }, eventAgeMs: 2, operationEnabled: true }), null)
  assert.equal(createPendingDeviceButtonAction({ event: { ...validEvent, button_id: 'mode' }, eventAgeMs: 2, operationEnabled: true }), null)
})

test('cloud device Ask always routes recorded speech to server STT instead of browser recognition', () => {
  assert.equal(shouldUseDeviceBrowserSpeechRecognition('cloud_uplink', true), false)
  assert.equal(shouldUseDeviceBrowserSpeechRecognition('cloud_uplink', false), false)
  assert.equal(shouldUseDeviceBrowserSpeechRecognition('firmware_wifi', true), true)
  assert.equal(shouldUseDeviceBrowserSpeechRecognition('firmware_wifi', false), false)
})
