export function getCameraLifecycleAnnouncement({ opening, running, error, wasRunning }) {
  if (error) return `Luồng camera gặp lỗi. ${error}`
  if (opening) return 'Đang mở camera sau.'
  if (running && !wasRunning) {
    return 'Theo dõi camera đã bắt đầu. Kết quả nhận diện có thể đọc trong danh sách bên dưới.'
  }
  if (!running && wasRunning) return 'Theo dõi camera đã dừng.'
  return ''
}
