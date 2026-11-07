export function getVoiceTtsRouteLabel(ready, provider) {
  if (!ready) return 'giọng đọc của thiết bị'
  return provider === 'vieneu_self_hosted'
    ? 'VieNeu-TTS trên máy chủ'
    : 'TTS trên máy chủ'
}
