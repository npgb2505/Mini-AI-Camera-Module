export function getVoiceReadiness(capabilities) {
  const realtimeReady = Boolean(capabilities?.voice_realtime_ready)
  const recordedServerReady = Boolean(
    capabilities?.transcription_ready && capabilities?.voice_browser_fallback_ready,
  )

  return {
    realtimeReady,
    recordedServerReady,
    ready: realtimeReady || recordedServerReady,
    mode: realtimeReady ? 'realtime' : recordedServerReady ? 'recorded' : 'unavailable',
  }
}
