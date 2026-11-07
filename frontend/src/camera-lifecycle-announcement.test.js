import assert from 'node:assert/strict'
import test from 'node:test'
import { getCameraLifecycleAnnouncement } from './camera-lifecycle-announcement.js'

test('does not announce the initial idle screen or repeated running state', () => {
  assert.equal(getCameraLifecycleAnnouncement({ opening: false, running: false, error: '', wasRunning: false }), '')
  assert.equal(getCameraLifecycleAnnouncement({ opening: false, running: true, error: '', wasRunning: true }), '')
})

test('announces camera lifecycle transitions and errors', () => {
  assert.equal(getCameraLifecycleAnnouncement({ opening: true, running: false, error: '', wasRunning: false }), 'Đang mở camera sau.')
  assert.equal(
    getCameraLifecycleAnnouncement({ opening: false, running: true, error: '', wasRunning: false }),
    'Theo dõi camera đã bắt đầu. Kết quả nhận diện có thể đọc trong danh sách bên dưới.',
  )
  assert.equal(getCameraLifecycleAnnouncement({ opening: false, running: false, error: '', wasRunning: true }), 'Theo dõi camera đã dừng.')
  assert.equal(getCameraLifecycleAnnouncement({ opening: false, running: false, error: 'Safari từ chối camera.', wasRunning: false }), 'Luồng camera gặp lỗi. Safari từ chối camera.')
})
