import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Camera, CameraSlash, Microphone, MicrophoneSlash, SpinnerGap, SpeakerHigh, WifiHigh } from '@phosphor-icons/react'
import {
  isCurrentVoiceReadinessOwner,
  isCurrentVoiceSession,
  isCurrentVoiceStartup,
} from './recording-session.js'
import {
  createVoiceTurnTrace,
  formatVoiceLatency,
  markVoiceTurnStage,
  summarizeVoiceTurnTrace,
} from './voice-turn-metrics.js'
import { resumeVoiceAudioContext } from './voice-audio-resume.js'
import { realtimeAudioFrameForState, REALTIME_SILENCE_FRAME } from './voice-audio-keepalive.js'
import { RealtimeSpeechGate } from './realtime-speech-gate.js'
import { VoiceSpeechStartGate } from './voice-speech-start.js'
import { getVoiceTtsRouteLabel } from './voice-output-route.js'

function socketUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return scheme + '//' + window.location.host + '/api/voice/realtime'
}

function speechRecognitionConstructor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function browserSpeechAvailable() {
  return Boolean(speechRecognitionConstructor())
}

function isLikelyLoopbackInput(label = '') {
  return /stereo\s*mix|loopback|what\s*u\s*hear|virtual\s*cable|voicemeeter/i.test(label)
}

function parseSseBlock(block) {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
  if (!data) return null
  try { return JSON.parse(data) } catch { return null }
}

function voiceError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return 'Trình duyệt chưa được cấp quyền micro. Hãy cho phép Microphone cho trang này rồi thử lại.'
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'Không tìm thấy micro trên thiết bị này.'
  }
  if (error?.name === 'SecurityError') return 'Micro cần được mở trên trang HTTPS hoặc localhost.'
  if (error?.name === 'NotSupportedError') return 'Trình duyệt chưa hỗ trợ chức năng thu âm cần thiết.'
  return error?.message || 'Chưa mở được cuộc trò chuyện. Kiểm tra quyền micro và kết nối mạng.'
}

export default function CloudVoiceScreen({ capabilities, voiceRate = 0.92, onBack }) {
  const videoRef = useRef(null)
  const socketRef = useRef(null)
  const streamRef = useRef(null)
  const contextRef = useRef(null)
  const sourceRef = useRef(null)
  const processorRef = useRef(null)
  const frameTimerRef = useRef(null)
  const voiceActivityTimerRef = useRef(null)
  const voiceReadyTimerRef = useRef(null)
  const serverSpeechTimeoutRef = useRef(null)
  const recognitionRef = useRef(null)
  const recognitionRestartRef = useRef(null)
  const recognitionRetryCountRef = useRef(0)
  const recognitionWantedRef = useRef(false)
  const continuousRecorderModeRef = useRef(false)
  const recorderRef = useRef(null)
  const voiceSessionTokenRef = useRef(0)
  const screenWakeLockRef = useRef(null)
  const voiceTraceRef = useRef(null)
  const voiceModeRef = useRef('none')
  const turnHistoryRef = useRef([])
  const turnAbortRef = useRef(null)
  const stopPromiseRef = useRef(null)
  const micSignalRef = useRef(false)
  const micSignalUiTimeRef = useRef(0)
  const stateRef = useRef('idle')
  const assistantSpeakingRef = useRef(false)
  const assistantDoneRef = useRef(false)
  const micResumePendingRef = useRef(false)
  const realtimeKeepaliveAtRef = useRef(0)
  const speechPendingRef = useRef(0)
  const speechBufferRef = useRef('')
  const speechQueueRef = useRef([])
  const speechQueueActiveRef = useRef(false)
  const speechPlaybackTokenRef = useRef(0)
  const serverSpeechSourceRef = useRef(null)
  const serverSpeechAbortRef = useRef(null)
  const assistantReplyIdRef = useRef(null)
  const playbackAckSentRef = useRef(false)
  const [sessionState, setSessionState] = useState('idle')
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [recordingQuestion, setRecordingQuestion] = useState(false)
  const [recordedTranscription, setRecordedTranscription] = useState(false)
  const [contextTurnsLoaded, setContextTurnsLoaded] = useState(0)
  const [lastVoiceMetrics, setLastVoiceMetrics] = useState(null)
  const [voiceModeOverride, setVoiceModeOverride] = useState(null)
  const [speechOutputStatus, setSpeechOutputStatus] = useState('')
  const [micSignal, setMicSignal] = useState(false)
  const [audioInputs, setAudioInputs] = useState([])
  const [selectedAudioInputId, setSelectedAudioInputId] = useState('')
  const [activeAudioInputLabel, setActiveAudioInputLabel] = useState('')
  const [activeAudioInputId, setActiveAudioInputId] = useState('')
  const voiceRealtimeConfigured = capabilities?.voice_realtime_configured ?? capabilities?.voice_realtime_ready
  const voiceMode = voiceModeOverride || (voiceRealtimeConfigured
    ? 'realtime'
    : capabilities?.transcription_ready && capabilities?.voice_browser_fallback_ready
      ? 'recorded'
      : 'none')
  const assistantModelLabel = capabilities?.vision_provider === 'ollama'
    ? `${capabilities?.vision_model || 'Qwen-VL'} trên laptop`
    : capabilities?.vision_provider === 'cloudflare'
      ? `${capabilities?.vision_model || 'mô hình Vision'} trên Cloudflare`
      : capabilities?.vision_model || 'mô hình AI'
  const browserSpeechLabel = capabilities?.voice_browser_stt_model || 'Speech Recognition tiếng Việt của thiết bị'
  const realtimeSttLabel = capabilities?.voice_realtime_model || capabilities?.voice_stt_model || 'STT realtime'
  const realtimeAssistantLabel = capabilities?.voice_assistant_model || assistantModelLabel
  const recordedSttLabel = capabilities?.transcription_model || capabilities?.transcription_provider || 'mô hình phiên âm trên máy chủ'
  const recordedQuestionReady = Boolean(capabilities?.transcription_ready && capabilities?.voice_browser_fallback_ready)
  voiceModeRef.current = voiceMode

  useEffect(() => {
    let mounted = true
    const refreshAudioInputs = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (mounted) setAudioInputs(devices.filter((device) => device.kind === 'audioinput'))
      } catch {}
    }
    void refreshAudioInputs()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioInputs)
    return () => {
      mounted = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshAudioInputs)
    }
  }, [])

  const noteActiveAudioInput = async (stream) => {
    const track = stream?.getAudioTracks?.()[0]
    if (track) {
      setActiveAudioInputLabel(track.label || 'Micro đang dùng')
      setActiveAudioInputId(track.getSettings?.().deviceId || '')
    }
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      setAudioInputs((await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput'))
    } catch {}
  }

  const audioCaptureConstraints = () => ({
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    // Automatic gain can lift steady fan/air noise above a software VAD threshold.
    autoGainControl: false,
    ...(selectedAudioInputId ? { deviceId: { exact: selectedAudioInputId } } : {}),
  })

  const stopBrowserRecognition = () => {
    recognitionWantedRef.current = false
    if (recognitionRestartRef.current) {
      window.clearTimeout(recognitionRestartRef.current)
      recognitionRestartRef.current = null
    }
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (recognition) {
      recognition.onend = null
      recognition.onerror = null
      try { recognition.stop() } catch {}
    }
  }

  const acquireScreenWakeLock = async () => {
    if (!navigator.wakeLock?.request || document.visibilityState !== 'visible') return
    if (screenWakeLockRef.current && !screenWakeLockRef.current.released) return
    try {
      const sentinel = await navigator.wakeLock.request('screen')
      if (stateRef.current === 'idle' || stateRef.current === 'error') {
        await sentinel.release().catch(() => {})
        return
      }
      screenWakeLockRef.current = sentinel
      sentinel.addEventListener('release', () => {
        if (screenWakeLockRef.current === sentinel) screenWakeLockRef.current = null
      }, { once: true })
    } catch {
      // Wake lock is optional; microphone capture remains foreground-only.
    }
  }

  const releaseScreenWakeLock = async () => {
    const sentinel = screenWakeLockRef.current
    screenWakeLockRef.current = null
    if (sentinel && !sentinel.released) await sentinel.release().catch(() => {})
  }

  const transition = (next) => {
    stateRef.current = next
    setSessionState(next)
    if (next === 'idle' || next === 'error') void releaseScreenWakeLock()
  }

  const updateMicSignal = (rms) => {
    const active = stateRef.current === 'listening' && rms >= 0.03
    const now = performance.now()
    if (active !== micSignalRef.current || now - micSignalUiTimeRef.current >= 300) {
      micSignalRef.current = active
      micSignalUiTimeRef.current = now
      setMicSignal(active)
    }
  }

  const noteVoiceStage = (trace, stage, metadata = {}) => {
    if (voiceTraceRef.current !== trace) return
    if (!markVoiceTurnStage(trace, stage, performance.now(), metadata)) return
    setLastVoiceMetrics(summarizeVoiceTurnTrace(trace))
  }

  const resetVoiceTrace = () => {
    voiceTraceRef.current = null
    setLastVoiceMetrics(null)
  }

  const releaseMedia = async () => {
    stopBrowserRecognition()
    const voiceReadyTimer = voiceReadyTimerRef.current
    voiceReadyTimerRef.current = null
    if (voiceReadyTimer) window.clearTimeout(voiceReadyTimer.id)
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder?.state === 'recording') {
      recorder.ondataavailable = null
      recorder.onstop = null
      try { recorder.stop() } catch {}
    }
    const frameTimer = frameTimerRef.current
    frameTimerRef.current = null
    if (frameTimer) window.clearInterval(frameTimer)
    const voiceActivityTimer = voiceActivityTimerRef.current
    voiceActivityTimerRef.current = null
    if (voiceActivityTimer) window.clearInterval(voiceActivityTimer)
    const processor = processorRef.current
    processorRef.current = null
    const source = sourceRef.current
    sourceRef.current = null
    processor?.disconnect()
    source?.disconnect()
    const context = contextRef.current
    contextRef.current = null
    const stream = streamRef.current
    streamRef.current = null
    if (videoRef.current?.srcObject === stream) videoRef.current.srcObject = null
    stream?.getTracks().forEach((track) => track.stop())
    if (context && context.state !== 'closed') {
      try { await context.close() } catch {}
    }
  }

  const failVoiceSession = async (message) => {
    const failedSessionToken = ++voiceSessionTokenRef.current
    const socket = socketRef.current
    socketRef.current = null
    turnAbortRef.current?.abort()
    turnAbortRef.current = null
    try {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }))
      socket?.close()
    } catch {}
    continuousRecorderModeRef.current = false
    recognitionWantedRef.current = false
    assistantSpeakingRef.current = false
    assistantDoneRef.current = false
    micResumePendingRef.current = false
    assistantReplyIdRef.current = null
    playbackAckSentRef.current = false
    cancelDeviceSpeech()
    setRecordingQuestion(false)
    setSpeechOutputStatus('')
    setError(message)
    transition('stopping')
    await releaseMedia()
    if (failedSessionToken === voiceSessionTokenRef.current) transition('error')
  }

  const finishSpeech = (sessionToken = voiceSessionTokenRef.current) => {
    if (!isCurrentVoiceSession(sessionToken, voiceSessionTokenRef.current, stateRef.current)) return
    if (assistantDoneRef.current && speechPendingRef.current === 0 && !micResumePendingRef.current) {
      const replyId = assistantReplyIdRef.current
      const socket = socketRef.current
      if (voiceModeRef.current === 'realtime' && replyId !== null && !playbackAckSentRef.current) {
        try {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'assistant_playback_done', reply_id: replyId }))
          }
        } catch {}
        playbackAckSentRef.current = true
      }
      assistantReplyIdRef.current = null
      micResumePendingRef.current = true
      const context = contextRef.current
      if (context && context.state !== 'running') transition('resuming')
      void (async () => {
        const audioReady = context ? await resumeVoiceAudioContext(context) : true
        if (!isCurrentVoiceSession(sessionToken, voiceSessionTokenRef.current, stateRef.current)) {
          micResumePendingRef.current = false
          return
        }
        const audioTrackMissing = ['realtime', 'recorded'].includes(voiceModeRef.current)
          && (!streamRef.current?.getAudioTracks?.().some((track) => track.readyState === 'live'))
        if (!audioReady || audioTrackMissing) {
          micResumePendingRef.current = false
          assistantSpeakingRef.current = false
          assistantDoneRef.current = false
          await failVoiceSession(audioTrackMissing
            ? 'Micro đã ngắt sau khi đọc câu trả lời. Bấm nút thử lại để mở phiên thoại mới.'
            : 'Micro chưa mở lại sau khi đọc câu trả lời. Bấm nút thử lại để mở phiên thoại mới.')
          return
        }
        assistantSpeakingRef.current = false
        assistantDoneRef.current = false
        micResumePendingRef.current = false
        transition('listening')
        if (voiceModeRef.current === 'browser' && recognitionWantedRef.current) {
          if (recognitionRestartRef.current) window.clearTimeout(recognitionRestartRef.current)
          recognitionRestartRef.current = window.setTimeout(() => {
            recognitionRestartRef.current = null
            startBrowserRecognition(sessionToken)
          }, 500)
        }
      })()
    }
  }

  const cancelDeviceSpeech = () => {
    speechPlaybackTokenRef.current += 1
    speechPendingRef.current = 0
    speechBufferRef.current = ''
    speechQueueRef.current = []
    speechQueueActiveRef.current = false
    serverSpeechAbortRef.current?.abort()
    serverSpeechAbortRef.current = null
    if (serverSpeechTimeoutRef.current) {
      window.clearTimeout(serverSpeechTimeoutRef.current)
      serverSpeechTimeoutRef.current = null
    }
    const serverSource = serverSpeechSourceRef.current
    serverSpeechSourceRef.current = null
    if (serverSource) {
      serverSource.onended = null
      try { serverSource.stop() } catch {}
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }

  const pumpSpeechQueue = () => {
    if (speechQueueActiveRef.current) return
    const item = speechQueueRef.current.shift()
    if (!item) return
    if (item.playbackToken !== speechPlaybackTokenRef.current) {
      speechPendingRef.current = Math.max(0, speechPendingRef.current - 1)
      pumpSpeechQueue()
      return
    }

    speechQueueActiveRef.current = true
    if (capabilities?.voice_tts_ready) {
      const abort = new AbortController()
      let ttsRequestTimedOut = false
      let audioPreparationTimedOut = false
      let itemFinished = false
      serverSpeechAbortRef.current = abort
      const finishServerItem = (failure = '') => {
        if (itemFinished || item.playbackToken !== speechPlaybackTokenRef.current) return
        itemFinished = true
        if (serverSpeechTimeoutRef.current) {
          window.clearTimeout(serverSpeechTimeoutRef.current)
          serverSpeechTimeoutRef.current = null
        }
        if (serverSpeechAbortRef.current === abort) serverSpeechAbortRef.current = null
        if (serverSpeechSourceRef.current?.__voiceQueueItem === item) serverSpeechSourceRef.current = null
        speechQueueActiveRef.current = false
        speechPendingRef.current = Math.max(0, speechPendingRef.current - 1)
        if (failure) setSpeechOutputStatus(failure)
        finishSpeech(item.sessionToken)
        pumpSpeechQueue()
      }
      setSpeechOutputStatus('Đang tạo giọng đọc tiếng Việt trên máy chủ…')
      serverSpeechTimeoutRef.current = window.setTimeout(() => {
        if (serverSpeechAbortRef.current === abort) {
          ttsRequestTimedOut = true
          abort.abort()
        }
      }, 20000)
      void (async () => {
        try {
          const response = await fetch('/api/voice/synthesize', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: item.text }),
            signal: abort.signal,
          })
          if (!response.ok) {
            const payload = await response.json().catch(() => null)
            throw new Error(payload?.error || 'Máy chủ chưa tạo được giọng đọc.')
          }
          const bytes = await response.arrayBuffer()
          if (itemFinished || item.playbackToken !== speechPlaybackTokenRef.current) return
          if (serverSpeechTimeoutRef.current) window.clearTimeout(serverSpeechTimeoutRef.current)
          serverSpeechTimeoutRef.current = window.setTimeout(() => {
            audioPreparationTimedOut = true
            finishServerItem('Không mở được audio trả lời; app đã mở lại micro. Câu trả lời vẫn còn trên màn hình.')
          }, 20000)
          const context = contextRef.current
          if (!context || context.state === 'closed') throw new Error('Đường phát âm thanh chưa sẵn sàng.')
          if (context.state !== 'running') await context.resume()
          if (itemFinished || item.playbackToken !== speechPlaybackTokenRef.current) return
          const audioBuffer = await context.decodeAudioData(bytes.slice(0))
          if (itemFinished || item.playbackToken !== speechPlaybackTokenRef.current) return
          if (serverSpeechTimeoutRef.current) window.clearTimeout(serverSpeechTimeoutRef.current)
          const source = context.createBufferSource()
          source.__voiceQueueItem = item
          source.buffer = audioBuffer
          source.connect(context.destination)
          source.onended = () => finishServerItem()
          serverSpeechSourceRef.current = source
          if (serverSpeechTimeoutRef.current) window.clearTimeout(serverSpeechTimeoutRef.current)
          serverSpeechTimeoutRef.current = window.setTimeout(
            () => {
              if (serverSpeechSourceRef.current === source) {
                serverSpeechSourceRef.current = null
                source.onended = null
                try { source.stop() } catch {}
              }
              finishServerItem('Audio đọc bị treo; app đã mở lại micro. Câu trả lời vẫn còn trên màn hình.')
            },
            Math.min(60000, Math.max(12000, audioBuffer.duration * 1000 + 8000)),
          )
          setSpeechOutputStatus(`Đang phát giọng đọc ${capabilities?.voice_tts_provider === 'vieneu_self_hosted' ? 'VieNeu-TTS tự host' : 'máy chủ'}.`)
          if (item.trace) noteVoiceStage(item.trace, 'tts_started')
          source.start(0)
        } catch (error) {
          if (itemFinished || item.playbackToken !== speechPlaybackTokenRef.current) return
          if (error?.name === 'AbortError' && serverSpeechAbortRef.current !== abort) return
          finishServerItem(ttsRequestTimedOut
            ? 'Máy chủ giọng đọc phản hồi quá lâu; app đã mở lại micro. Câu trả lời vẫn còn trên màn hình.'
            : audioPreparationTimedOut
              ? 'Không mở được audio trả lời; app đã mở lại micro. Câu trả lời vẫn còn trên màn hình.'
            : error?.message || 'Không phát được audio TTS từ máy chủ.')
        }
      })()
      return
    }
    const utterance = new window.SpeechSynthesisUtterance(item.text)
    utterance.lang = 'vi-VN'
    utterance.rate = Number(voiceRate) || 0.92
    const vietnameseVoice = window.speechSynthesis.getVoices?.().find((voice) => /^vi(?:-|$)/i.test(voice.lang))
    if (vietnameseVoice && !item.useDefaultVoice) utterance.voice = vietnameseVoice
    utterance.volume = 1
    let completed = false
    let abandonedForFallback = false
    let watchdog = null
    const finishItem = (failure = '') => {
      if (completed || abandonedForFallback) return
      completed = true
      if (watchdog) window.clearTimeout(watchdog)
      if (item.playbackToken !== speechPlaybackTokenRef.current) return
      speechQueueActiveRef.current = false
      speechPendingRef.current = Math.max(0, speechPendingRef.current - 1)
      if (failure) setSpeechOutputStatus(failure)
      finishSpeech(item.sessionToken)
      pumpSpeechQueue()
    }
    utterance.onstart = () => {
      if (item.playbackToken !== speechPlaybackTokenRef.current) return
      setSpeechOutputStatus(item.useDefaultVoice
        ? 'Đang thử giọng mặc định của thiết bị sau lỗi giọng tiếng Việt.'
        : vietnameseVoice
          ? `Đang đọc bằng ${vietnameseVoice.name}.`
          : 'Đang đọc bằng giọng hệ thống; thiết bị chưa công bố voice tiếng Việt riêng.')
      if (item.trace) noteVoiceStage(item.trace, 'tts_started')
    }
    utterance.onend = () => finishItem()
    utterance.onerror = (event) => {
      if (item.playbackToken !== speechPlaybackTokenRef.current) {
        finishItem()
        return
      }
      const reason = event?.error === 'canceled' || event?.error === 'interrupted'
        ? 'bị ngắt giữa chừng'
        : `gặp lỗi${event?.error ? ` (${event.error})` : ''}`
      const canRetryWithDefault = Boolean(vietnameseVoice && !item.useDefaultVoice)
      const failure = canRetryWithDefault
        ? `Giọng đọc tiếng Việt ${reason}; đang thử giọng mặc định của thiết bị.`
        : `Giọng đọc tiếng Việt ${reason}. Kiểm tra giọng đọc trong cài đặt thiết bị hoặc bấm “Nghe lại”.`
      if (canRetryWithDefault) {
        abandonedForFallback = true
        if (watchdog) window.clearTimeout(watchdog)
        speechQueueActiveRef.current = false
        speechQueueRef.current.unshift({ ...item, useDefaultVoice: true })
        pumpSpeechQueue()
        return
      }
      finishItem(failure)
    }
    watchdog = window.setTimeout(() => {
      finishItem('Thiết bị không hoàn tất lượt đọc đúng hạn. Kiểm tra âm lượng/giọng đọc hoặc bấm “Nghe lại”.')
    }, Math.min(45000, 8000 + item.text.length * 220))
    try {
      window.speechSynthesis.resume()
      window.speechSynthesis.speak(utterance)
    } catch (error) {
      finishItem(`Không phát được giọng đọc trên thiết bị${error?.name ? ` (${error.name})` : ''}. Bấm “Nghe lại” để thử lại.`)
    }
  }

  const speakChunk = (text, sessionToken = voiceSessionTokenRef.current) => {
    const clean = text.trim()
    if (!clean) return
    if (!capabilities?.voice_tts_ready && (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function')) {
      setSpeechOutputStatus('Thiết bị này chưa hỗ trợ đọc thành tiếng. Câu trả lời vẫn hiện dưới dạng chữ.')
      return
    }
    speechPendingRef.current += 1
    speechQueueRef.current.push({
      text: clean,
      sessionToken,
      playbackToken: speechPlaybackTokenRef.current,
      trace: voiceTraceRef.current,
    })
    pumpSpeechQueue()
  }

  const queueSpeech = (text, final = false, sessionToken = voiceSessionTokenRef.current) => {
    if (!capabilities?.voice_tts_ready && (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function')) {
      speechBufferRef.current = ''
      if (text || final) setSpeechOutputStatus('Trình duyệt này không có giọng đọc thành tiếng. Câu trả lời vẫn hiện trên màn hình; hãy bật giọng đọc trong thiết bị hoặc mở app bằng Safari/Chrome mới.')
      return
    }
    speechBufferRef.current += text
    let remaining = speechBufferRef.current
    const boundary = /[.!?…](?:\s+|$)/u
    let match
    while ((match = boundary.exec(remaining))) {
      const cut = match.index + match[0].length
      speakChunk(remaining.slice(0, cut), sessionToken)
      remaining = remaining.slice(cut)
    }
    if (!final && remaining.length > 100) {
      const cut = remaining.lastIndexOf(' ', 90)
      if (cut > 35) {
        speakChunk(remaining.slice(0, cut), sessionToken)
        remaining = remaining.slice(cut + 1)
      }
    }
    if (final && remaining.trim()) speakChunk(remaining, sessionToken)
    speechBufferRef.current = remaining
  }

  const sendCameraFrame = async (ownerSocket = socketRef.current, isSessionCurrent = () => true) => {
    const socket = ownerSocket
    const video = videoRef.current
    if (!isSessionCurrent() || socketRef.current !== socket || !cameraEnabled || !video || video.readyState < 2 || socket?.readyState !== WebSocket.OPEN) return
    const width = Math.min(640, video.videoWidth || 640)
    const height = Math.max(1, Math.round(width * ((video.videoHeight || 480) / Math.max(video.videoWidth || 640, 1))))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return
    context.drawImage(video, 0, 0, width, height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.55))
    if (!blob || blob.size > 240000 || !isSessionCurrent() || socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('Không đọc được khung hình camera.'))
      reader.readAsDataURL(blob)
    }).catch(() => null)
    if (typeof data === 'string' && isSessionCurrent() && socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'frame', data }))
    }
  }

  const captureVoiceFrame = async () => {
    const video = videoRef.current
    if (!cameraEnabled || !video || video.readyState < 2) return null
    const width = Math.min(640, video.videoWidth || 640)
    const height = Math.max(1, Math.round(width * ((video.videoHeight || 480) / Math.max(video.videoWidth || 640, 1))))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return null
    context.drawImage(video, 0, 0, width, height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.48))
    return blob && blob.size <= 240000 ? blob : null
  }

  const sendBrowserTurn = async (text, frameOverride, isSessionCurrent = () => true, trace = null) => {
    if (!isSessionCurrent()) return
    const cleanText = String(text || '').trim().slice(0, 400)
    if (!cleanText || stateRef.current === 'idle' || stateRef.current === 'error') return
    if (recognitionRestartRef.current) {
      window.clearTimeout(recognitionRestartRef.current)
      recognitionRestartRef.current = null
    }
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (recognition) {
      recognition.onend = null
      recognition.onerror = null
      try {
        if (typeof recognition.abort === 'function') recognition.abort()
        else recognition.stop()
      } catch {}
    }

    assistantSpeakingRef.current = true
    assistantDoneRef.current = false
    cancelDeviceSpeech()
    setError('')
    setTranscript(cleanText)
    setAnswer('')
    transition('speaking')

    const priorHistory = turnHistoryRef.current.slice(-8)
    turnHistoryRef.current = [...priorHistory, { role: 'user', content: cleanText }].slice(-8)
    const form = new FormData()
    form.set('text', cleanText)
    form.set('history', JSON.stringify(priorHistory))
    const controller = new AbortController()
    turnAbortRef.current = controller
    const turnTimeout = window.setTimeout(() => controller.abort(), 45000)
    try {
      const frame = frameOverride === undefined ? await captureVoiceFrame() : frameOverride
      if (!isSessionCurrent()) return
      if (frame) form.set('image', frame, 'voice-frame.jpg')
      if (trace) noteVoiceStage(trace, 'model_request_started')
      const response = await fetch('/api/voice/turn', { method: 'POST', body: form, credentials: 'same-origin', signal: controller.signal })
      if (!isSessionCurrent()) {
        if (response.body) await response.body.cancel().catch(() => {})
        return
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error || 'Chưa gửi được câu nói tới mô hình trên cloud.')
      }
      if (!response.body) throw new Error('Trình duyệt chưa hỗ trợ nhận câu trả lời truyền trực tiếp.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamedAnswer = ''
      let gotDone = false
      const consume = (block) => {
        if (!isSessionCurrent()) return
        const message = parseSseBlock(block)
        if (!message) return
        if (message.type === 'context') {
          setContextTurnsLoaded(Math.max(0, Number(message.turns) || 0))
        } else if (message.type === 'delta') {
          const delta = String(message.text || '')
          if (trace) noteVoiceStage(trace, 'model_first_token')
          streamedAnswer += delta
          setAnswer((current) => current + delta)
          queueSpeech(delta)
        } else if (message.type === 'done') {
          const fullText = String(message.text || streamedAnswer)
          if (trace) noteVoiceStage(trace, 'model_completed')
          setAnswer(fullText)
          turnHistoryRef.current = [...turnHistoryRef.current, { role: 'assistant', content: fullText }].slice(-8)
          assistantDoneRef.current = true
          gotDone = true
          queueSpeech('', true)
          finishSpeech()
        } else if (message.type === 'error') {
          throw new Error(String(message.message || 'Mình chưa trả lời được lượt này.'))
        }
      }

      while (true) {
        const { value, done } = await reader.read()
        if (!isSessionCurrent()) {
          await reader.cancel().catch(() => {})
          return
        }
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() || ''
        blocks.forEach(consume)
      }
      buffer += decoder.decode()
      if (buffer.trim()) consume(buffer.trim())
      if (!gotDone) throw new Error('Kết nối cloud kết thúc trước khi có câu trả lời hoàn chỉnh.')
    } catch (turnError) {
      if (!isSessionCurrent()) return
      if (turnError?.name === 'AbortError' && stateRef.current === 'idle') return
      assistantSpeakingRef.current = false
      assistantDoneRef.current = false
      if (continuousRecorderModeRef.current) {
        setError(`${voiceError(turnError)} Mình vẫn đang nghe; bạn có thể hỏi lại.`)
        transition('listening')
        return
      }
      recognitionWantedRef.current = false
      await failVoiceSession(voiceError(turnError))
    } finally {
      window.clearTimeout(turnTimeout)
      if (turnAbortRef.current === controller) turnAbortRef.current = null
    }
  }

  const startBrowserRecognition = (sessionToken = voiceSessionTokenRef.current) => {
    const sessionIsCurrent = () => isCurrentVoiceSession(
      sessionToken,
      voiceSessionTokenRef.current,
      stateRef.current,
    )
    if (!sessionIsCurrent() || !recognitionWantedRef.current || stateRef.current !== 'listening' || assistantSpeakingRef.current || recognitionRef.current) return
    const Recognition = speechRecognitionConstructor()
    if (!Recognition) {
      if (!sessionIsCurrent()) return
      void failVoiceSession('Trình duyệt này chưa hỗ trợ nhận giọng nói. Dùng Safari/Chrome mới hoặc mic Dictation để nhập câu hỏi.')
      return
    }
    const recognition = new Recognition()
    recognition.lang = 'vi-VN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onstart = () => {
      recognitionRetryCountRef.current = 0
      setError('')
    }
    recognition.onresult = (event) => {
      if (!sessionIsCurrent() || recognitionRef.current !== recognition) return
      let interim = ''
      let finalText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const phrase = result[0]?.transcript || ''
        if (result.isFinal) finalText += phrase + ' '
        else interim += phrase
      }
      if (finalText.trim()) {
        setTranscript(finalText.trim())
        const trace = createVoiceTurnTrace()
        voiceTraceRef.current = trace
        noteVoiceStage(trace, 'transcription_response_received', {
          transcriptionProvider: 'Safari',
          transcriptionModel: browserSpeechLabel,
        })
        void sendBrowserTurn(finalText.trim(), undefined, sessionIsCurrent, trace)
      } else if (interim.trim()) {
        setTranscript(interim.trim())
      }
    }
    recognition.onerror = (event) => {
      if (!sessionIsCurrent() || recognitionRef.current !== recognition) return
      if (event.error === 'no-speech' || event.error === 'aborted') return
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        recognitionWantedRef.current = false
        recognitionRef.current = null
        recognition.onend = null
        recognition.onerror = null
        try { recognition.stop() } catch {}
        void failVoiceSession('Trình duyệt chưa được phép nhận giọng nói. Bật quyền Microphone rồi thử lại.')
      } else if (event.error === 'network') {
        recognitionRetryCountRef.current += 1
        recognitionRef.current = null
        recognition.onend = null
        recognition.onerror = null
        try { recognition.abort?.() } catch {}
        if (recordedQuestionReady && voiceModeRef.current === 'browser') {
          recognitionWantedRef.current = false
          setError('Dịch vụ nhận giọng nói của trình duyệt bị mất kết nối; đang chuyển sang nghe liên tục qua máy chủ.')
          void startContinuousRecordedConversation(sessionToken)
        } else {
          setError('Nhận giọng nói của trình duyệt bị mất kết nối; app đang tự nối lại micro.')
          if (recognitionRestartRef.current) window.clearTimeout(recognitionRestartRef.current)
          const retryDelay = Math.min(6000, 600 * (2 ** Math.min(recognitionRetryCountRef.current, 3)))
          recognitionRestartRef.current = window.setTimeout(() => {
            recognitionRestartRef.current = null
            startBrowserRecognition(sessionToken)
          }, retryDelay)
        }
      } else if (event.error === 'audio-capture') {
        recognitionWantedRef.current = false
        recognitionRef.current = null
        recognition.onend = null
        recognition.onerror = null
        try { recognition.abort?.() } catch {}
        void failVoiceSession('Trình duyệt không lấy được micro. Kiểm tra quyền micro hoặc ứng dụng khác đang dùng micro.')
      }
    }
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null
      if (!sessionIsCurrent()) return
      if (recognitionWantedRef.current && stateRef.current === 'listening' && !assistantSpeakingRef.current) {
        if (recognitionRestartRef.current) window.clearTimeout(recognitionRestartRef.current)
        const retryDelay = Math.min(6000, 600 * (2 ** Math.min(recognitionRetryCountRef.current, 3)))
        recognitionRestartRef.current = window.setTimeout(() => {
          recognitionRestartRef.current = null
          startBrowserRecognition(sessionToken)
        }, retryDelay)
      }
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch (startError) {
      if (recognitionRef.current === recognition) recognitionRef.current = null
      if (!sessionIsCurrent()) return
      recognitionWantedRef.current = false
      recognition.onend = null
      recognition.onerror = null
      try { recognition.abort?.() } catch {}
      void failVoiceSession(voiceError(startError))
    }
  }

  const startContinuousRecordedConversation = async (sessionToken = voiceSessionTokenRef.current) => {
    const sessionIsCurrent = () => isCurrentVoiceSession(
      sessionToken,
      voiceSessionTokenRef.current,
      stateRef.current,
    )
    if (!recordedQuestionReady || !sessionIsCurrent()) return false

    stopBrowserRecognition()
    continuousRecorderModeRef.current = false
    await releaseMedia()
    if (!sessionIsCurrent()) return false
    transition('connecting')
    let stream = null
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.AudioContext) {
        throw new Error('Trình duyệt này chưa hỗ trợ micro liên tục. Hãy mở app bằng Safari hoặc Chrome mới qua HTTPS.')
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioCaptureConstraints(),
        video: cameraEnabled ? { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } } : false,
      })
      if (!sessionIsCurrent()) {
        stream.getTracks().forEach((track) => track.stop())
        return false
      }
      streamRef.current = stream
      void noteActiveAudioInput(stream)
      if (videoRef.current && cameraEnabled) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
      const context = new window.AudioContext()
      contextRef.current = context
      await context.resume()
      const source = context.createMediaStreamSource(stream)
      sourceRef.current = source
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      const audioStream = new MediaStream(stream.getAudioTracks())
      const speechStartGate = new VoiceSpeechStartGate(4)
      let activeRecorder = null
      let chunks = []
      let speechConfirmed = false
      let speechStartedAt = 0
      let silenceStartedAt = 0
      let ambientRmsWindow = []
      let ambientNoiseFloor = 0.004
      let highPassPreviousInput = 0
      let highPassPreviousOutput = 0
      const highPassAlpha = Math.exp(-2 * Math.PI * 120 / context.sampleRate)

      const beginUtterance = (startedAt) => {
        if (activeRecorder || stateRef.current !== 'listening' || !sessionIsCurrent()) return
        chunks = []
        speechConfirmed = false
        speechStartedAt = startedAt
        silenceStartedAt = 0
        const candidates = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
        const mimeType = window.MediaRecorder.isTypeSupported
          ? candidates.find((type) => window.MediaRecorder.isTypeSupported(type))
          : null
        const recorder = mimeType
          ? new window.MediaRecorder(audioStream, { mimeType })
          : new window.MediaRecorder(audioStream)
        activeRecorder = recorder
        recorderRef.current = recorder
        recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
        recorder.onerror = () => {
          if (activeRecorder !== recorder) return
          activeRecorder = null
          recorderRef.current = null
          speechConfirmed = false
          speechStartGate.reset()
          setRecordingQuestion(false)
          setError('Không ghi được câu nói. App vẫn đang mở micro; thử nói lại nhé.')
          transition('listening')
        }
        recorder.onstop = async () => {
          if (activeRecorder === recorder) activeRecorder = null
          if (recorderRef.current === recorder) recorderRef.current = null
          setRecordingQuestion(false)
          if (!sessionIsCurrent()) return
          const shouldTranscribe = speechConfirmed
          speechConfirmed = false
          speechStartGate.reset()
          if (!shouldTranscribe) {
            chunks = []
            transition('listening')
            return
          }
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
          chunks = []
          if (blob.size < 1200) {
            transition('listening')
            return
          }
          transition('transcribing')
          const trace = createVoiceTurnTrace()
          voiceTraceRef.current = trace
          noteVoiceStage(trace, 'audio_stopped')
          try {
            const form = new FormData()
            const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'
            form.append('audio', blob, `voice-question.${extension}`)
            const transcriptionController = new AbortController()
            const transcriptionTimeout = window.setTimeout(() => transcriptionController.abort(), 20000)
            let response
            try {
              response = await fetch('/api/transcribe', {
                method: 'POST',
                body: form,
                credentials: 'same-origin',
                signal: transcriptionController.signal,
              })
            } finally {
              window.clearTimeout(transcriptionTimeout)
            }
            const payload = await response.json().catch(() => null)
            if (!sessionIsCurrent()) return
            if (!response.ok) throw new Error(payload?.error || 'Máy chủ chưa phiên âm được câu nói.')
            const cleanText = String(payload?.text || '').trim().slice(0, 400)
            if (!cleanText) {
              setError('Chưa nhận ra lời nói. Mình vẫn đang nghe; bạn thử nói lại nhé.')
              transition('listening')
              return
            }
            noteVoiceStage(trace, 'transcription_response_received', {
              transcriptionProvider: payload?.transcription_provider,
              transcriptionModel: payload?.transcription_model,
            })
            setTranscript(cleanText)
            setRecordedTranscription(true)
            setError('')
            const frame = await captureVoiceFrame().catch(() => null)
            if (!sessionIsCurrent()) return
            transition('listening')
            await sendBrowserTurn(cleanText, frame, sessionIsCurrent, trace)
          } catch (transcriptionError) {
            if (!sessionIsCurrent()) return
            setError(transcriptionError?.message || 'Không phiên âm được câu nói; app vẫn đang nghe.')
            transition('listening')
          }
        }
        try {
          recorder.start()
        } catch (recordingError) {
          activeRecorder = null
          recorderRef.current = null
          speechStartGate.reset()
          setError(voiceError(recordingError))
          transition('listening')
        }
      }

      voiceModeRef.current = 'recorded'
      setVoiceModeOverride('recorded')
      setRecordedTranscription(true)
      continuousRecorderModeRef.current = true
      setRecordingQuestion(false)
      setError('')
      transition('listening')
      voiceActivityTimerRef.current = window.setInterval(() => {
        if (!sessionIsCurrent() || !contextRef.current || contextRef.current.state === 'closed') return
        if (contextRef.current.state === 'suspended') void contextRef.current.resume().catch(() => {})
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) {
          const input = (sample - 128) / 128
          const output = highPassAlpha * (highPassPreviousOutput + input - highPassPreviousInput)
          highPassPreviousInput = input
          highPassPreviousOutput = output
          sum += output * output
        }
        const rms = Math.sqrt(sum / samples.length)
        const now = performance.now()
        updateMicSignal(rms)
        // Keep tracking the low-energy ambient floor during a recording too.
        // A baseline frozen at speech start can make steady fan/air noise look
        // like continuous speech, preventing the automatic end-of-turn timer.
        ambientRmsWindow.push(rms)
        if (ambientRmsWindow.length > 32) ambientRmsWindow.shift()
        if (ambientRmsWindow.length >= 8) {
          const ordered = [...ambientRmsWindow].sort((left, right) => left - right)
          const floorSample = ordered[Math.floor((ordered.length - 1) * 0.2)]
          ambientNoiseFloor += (floorSample - ambientNoiseFloor) * 0.12
          ambientNoiseFloor = Math.max(0.001, Math.min(0.08, ambientNoiseFloor))
        }
        if (stateRef.current !== 'listening' && !activeRecorder) return
        const speechStartThreshold = Math.max(0.03, ambientNoiseFloor * 1.55)
        if (!activeRecorder) {
          const candidate = speechStartGate.process(rms > speechStartThreshold, false, now)
          if (candidate.action === 'start') beginUtterance(candidate.startedAt)
          return
        }
        if (!speechConfirmed) {
          const candidate = speechStartGate.process(rms > speechStartThreshold, true, now)
          if (candidate.action === 'cancel') {
            try { if (activeRecorder.state === 'recording') activeRecorder.stop() } catch {}
          } else if (candidate.action === 'confirm') {
            speechConfirmed = true
            setRecordingQuestion(true)
            setTranscript('')
            setError('')
            transition('recording')
          }
          return
        }
        const speechEndThreshold = Math.max(0.014, ambientNoiseFloor * 1.55)
        if (rms > speechEndThreshold) silenceStartedAt = 0
        else if (!silenceStartedAt) silenceStartedAt = now
        const elapsed = now - speechStartedAt
        const silenceMs = silenceStartedAt ? now - silenceStartedAt : 0
        if ((elapsed >= 650 && silenceMs >= 700) || elapsed >= 9000) {
          try { if (activeRecorder.state === 'recording') activeRecorder.stop() } catch {}
        }
      }, 50)
      return true
    } catch (recordingError) {
      if (!sessionIsCurrent()) {
        stream?.getTracks().forEach((track) => track.stop())
        return false
      }
      setRecordingQuestion(false)
      await failVoiceSession(voiceError(recordingError))
      return false
    }
  }

  const startBrowserConversation = async (sessionToken) => {
    const startupIsCurrent = () => isCurrentVoiceStartup(
      sessionToken,
      voiceSessionTokenRef.current,
      stateRef.current,
    )
    if (!speechRecognitionConstructor()) {
      if (recordedQuestionReady) return startContinuousRecordedConversation(sessionToken)
      throw new Error('Trình duyệt này chưa hỗ trợ nhận giọng nói.')
    }
    continuousRecorderModeRef.current = false
    if (!startupIsCurrent()) return
    recognitionWantedRef.current = true
    turnHistoryRef.current = []
    if (cameraEnabled) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera cần được mở bằng Safari qua HTTPS.')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
      })
      if (!startupIsCurrent()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
    }
    if (!startupIsCurrent()) return
    transition('listening')
    startBrowserRecognition(sessionToken)
  }

  const startConversation = async () => {
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return
    void acquireScreenWakeLock()
    // Prime the device TTS during the user's click. Mobile Safari may block
    // speech synthesis started only from a later network callback.
    if (!capabilities?.voice_tts_ready && 'speechSynthesis' in window) {
      try { window.speechSynthesis.resume() } catch {}
    }
    // Every start is a fresh attempt at the best configured route. Do not
    // carry the previous session's browser-fallback mode into a new session.
    voiceModeRef.current = voiceRealtimeConfigured ? 'realtime' : voiceMode
    setVoiceModeOverride(null)
    resetVoiceTrace()
    const sessionToken = ++voiceSessionTokenRef.current
    const conversationIsCurrent = () => isCurrentVoiceSession(
      sessionToken,
      voiceSessionTokenRef.current,
      stateRef.current,
    )
    const startupIsCurrent = () => isCurrentVoiceStartup(
      sessionToken,
      voiceSessionTokenRef.current,
      stateRef.current,
    )
    setError('')
    setSpeechOutputStatus('')
    setRecordedTranscription(false)
    turnHistoryRef.current = []
    setContextTurnsLoaded(0)
    setTranscript('')
    setAnswer('')
    micSignalRef.current = false
    setMicSignal(false)
    assistantSpeakingRef.current = false
    assistantDoneRef.current = false
    micResumePendingRef.current = false
    assistantReplyIdRef.current = null
    playbackAckSentRef.current = false
    cancelDeviceSpeech()
    transition('connecting')
    const previousSocket = socketRef.current
    socketRef.current = null
    turnAbortRef.current?.abort()
    try { previousSocket?.close() } catch {}
    await releaseMedia()
    if (!startupIsCurrent()) return
    let browserFallbackPromise = null
    const fallbackToBrowser = (reason) => {
      if (!conversationIsCurrent()) return Promise.resolve(false)
      if (browserFallbackPromise) return browserFallbackPromise
      browserFallbackPromise = (async () => {
        if (!conversationIsCurrent()) return false
        const canFallback = recordedQuestionReady
        const socket = socketRef.current
        if (socketRef.current === socket) socketRef.current = null
        try { socket?.close() } catch {}
        turnAbortRef.current?.abort()
        turnAbortRef.current = null
        assistantSpeakingRef.current = false
        assistantDoneRef.current = false
    micResumePendingRef.current = false
        assistantReplyIdRef.current = null
        playbackAckSentRef.current = false
        cancelDeviceSpeech()
        await releaseMedia()
        if (!conversationIsCurrent()) return false

        if (!canFallback) {
          await failVoiceSession(`${reason || 'Luồng thoại realtime chưa kết nối được.'} Không có chế độ nhận giọng nói dự phòng khả dụng trên trình duyệt này.`)
          return false
        }

        voiceModeRef.current = 'recorded'
        setVoiceModeOverride('recorded')
        setError('Thoại realtime chưa kết nối được; đang chuyển sang nhận dạng giọng nói trên máy chủ.')
        transition('connecting')
        try {
          await startContinuousRecordedConversation(sessionToken)
          if (!conversationIsCurrent()) return false
          return true
        } catch (fallbackError) {
          if (!conversationIsCurrent()) return false
          await failVoiceSession(`Không mở được chế độ nhận giọng nói dự phòng. ${voiceError(fallbackError)}`)
          return false
        }
      })()
      return browserFallbackPromise
    }
    try {
      if (!voiceRealtimeConfigured) {
        if (recordedQuestionReady) {
          await startContinuousRecordedConversation(sessionToken)
          return
        }
        throw new Error('Dịch vụ thoại chưa được cấu hình trên cloud hoặc máy chủ này.')
      }
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
        throw new Error('Safari chưa hỗ trợ micro truyền trực tiếp. Cập nhật iOS rồi thử lại nhé.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioCaptureConstraints(),
        video: cameraEnabled ? { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } } : false,
      })
      if (!startupIsCurrent()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      void noteActiveAudioInput(stream)
      if (videoRef.current && cameraEnabled) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
      if (!startupIsCurrent()) return

      const context = new window.AudioContext()
      contextRef.current = context
      await context.audioWorklet.addModule('/pcm-capture-worklet.js')
      if (!startupIsCurrent()) return
      await context.resume()
      if (!startupIsCurrent()) return
      const source = context.createMediaStreamSource(stream)
      sourceRef.current = source
      const processor = new AudioWorkletNode(context, 'ro-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      })
      processorRef.current = processor
      const speechGate = new RealtimeSpeechGate()
      processor.port.onmessage = (event) => {
        if (!conversationIsCurrent()) return
        const socket = socketRef.current
        let gatedFrames = [REALTIME_SILENCE_FRAME]
        if (event.data instanceof ArrayBuffer && event.data.byteLength >= 2) {
          if (stateRef.current === 'listening') {
            const gateResult = speechGate.process(event.data)
            gatedFrames = gateResult.frames
            updateMicSignal(gateResult.speechActive ? gateResult.rms : 0)
          } else {
            speechGate.resetTurn()
            updateMicSignal(0)
          }
        }
        // Half-duplex prevents TTS echo from becoming a user turn. Send a small
        // silence frame every 5s during playback so Scribe's upstream socket
        // does not time out during a long streamed answer.
        if (socket?.readyState === WebSocket.OPEN) {
          const frameType = realtimeAudioFrameForState({
            state: stateRef.current,
            assistantSpeaking: assistantSpeakingRef.current,
            nowMs: performance.now(),
            lastKeepaliveAtMs: realtimeKeepaliveAtRef.current,
          })
          if (frameType === 'microphone') {
            for (const frame of gatedFrames) socket.send(frame)
          }
          else if (frameType === 'silence') {
            socket.send(REALTIME_SILENCE_FRAME)
            realtimeKeepaliveAtRef.current = performance.now()
          }
        }
      }
      source.connect(processor)
      processor.connect(context.destination)

      const socket = new WebSocket(socketUrl())
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket
      socket.addEventListener('open', () => {
        if (!conversationIsCurrent() || socketRef.current !== socket) return
        const previousReadyTimer = voiceReadyTimerRef.current
        if (previousReadyTimer) window.clearTimeout(previousReadyTimer.id)
        const readyTimer = { id: null, socket, sessionToken }
        readyTimer.id = window.setTimeout(() => {
          if (voiceReadyTimerRef.current !== readyTimer) return
          voiceReadyTimerRef.current = null
          if (!isCurrentVoiceReadinessOwner(
            readyTimer.sessionToken,
            voiceSessionTokenRef.current,
            stateRef.current,
            readyTimer.socket,
            socketRef.current,
          )) return
          void fallbackToBrowser('Máy chủ nhận giọng nói chưa sẵn sàng sau 12 giây.')
        }, 12000)
        voiceReadyTimerRef.current = readyTimer
        socket.send(JSON.stringify({ type: 'start', language: 'vi' }))
      }, { once: true })
      socket.addEventListener('message', (event) => {
        if (!conversationIsCurrent() || socketRef.current !== socket) return
        if (typeof event.data !== 'string') return
        let message
        try { message = JSON.parse(event.data) } catch { return }
        if (message.type === 'session_ready') {
          if (voiceReadyTimerRef.current?.socket === socket && voiceReadyTimerRef.current.sessionToken === sessionToken) {
            window.clearTimeout(voiceReadyTimerRef.current.id)
            voiceReadyTimerRef.current = null
          }
          setContextTurnsLoaded(Math.max(0, Number(message.context_turns_loaded) || 0))
          micSignalRef.current = false
          setMicSignal(false)
          transition('listening')
          if (cameraEnabled) frameTimerRef.current = window.setInterval(() => {
            void sendCameraFrame(socket, conversationIsCurrent)
          }, 1800)
        } else if (message.type === 'transcript') {
          setTranscript(String(message.text || ''))
          if (message.final) {
            speechGate.resetTurn()
            const trace = createVoiceTurnTrace()
            voiceTraceRef.current = trace
            noteVoiceStage(trace, 'transcription_response_received', {
              transcriptionProvider: 'Cloudflare',
              transcriptionModel: realtimeSttLabel,
            })
            assistantSpeakingRef.current = false
            assistantDoneRef.current = false
            micResumePendingRef.current = false
            cancelDeviceSpeech()
            assistantReplyIdRef.current = null
            playbackAckSentRef.current = false
            setSpeechOutputStatus('')
            setAnswer('')
            micSignalRef.current = false
            setMicSignal(false)
          }
        } else if (message.type === 'assistant_start') {
          speechGate.resetTurn()
          const trace = voiceTraceRef.current
          if (trace) noteVoiceStage(trace, 'model_request_started')
          assistantReplyIdRef.current = Number.isInteger(message.reply_id) ? message.reply_id : null
          playbackAckSentRef.current = false
          assistantSpeakingRef.current = true
          assistantDoneRef.current = false
          realtimeKeepaliveAtRef.current = performance.now()
          micResumePendingRef.current = false
          cancelDeviceSpeech()
          setSpeechOutputStatus('')
          setAnswer('')
          transition('speaking')
        } else if (message.type === 'assistant_delta') {
          if (message.reply_id != null && assistantReplyIdRef.current !== null && message.reply_id !== assistantReplyIdRef.current) return
          const delta = String(message.text || '')
          const trace = voiceTraceRef.current
          if (trace) noteVoiceStage(trace, 'model_first_token')
          setAnswer((current) => current + delta)
          queueSpeech(delta)
        } else if (message.type === 'assistant_done') {
          if (message.reply_id != null && assistantReplyIdRef.current !== null && message.reply_id !== assistantReplyIdRef.current) return
          const trace = voiceTraceRef.current
          if (trace) noteVoiceStage(trace, 'model_completed')
          const fullText = String(message.text || '')
          setAnswer(fullText)
          assistantDoneRef.current = true
          queueSpeech('', true)
          finishSpeech()
        } else if (message.type === 'assistant_interrupted') {
          if (message.reply_id != null && assistantReplyIdRef.current !== null && message.reply_id !== assistantReplyIdRef.current) return
          assistantReplyIdRef.current = null
          playbackAckSentRef.current = true
          assistantSpeakingRef.current = false
          assistantDoneRef.current = false
          micResumePendingRef.current = false
          cancelDeviceSpeech()
          setAnswer('')
          transition('listening')
        } else if (message.type === 'turn_error') {
          setError(String(message.message || 'Mình chưa trả lời được lượt này. Bạn thử nói lại nhé.'))
          transition('listening')
        } else if (message.type === 'voice_error') {
          const reason = String(message.message || 'Dịch vụ thoại gặp lỗi.')
          if (/giới hạn|hết thời lượng|giới hạn 5 phút/i.test(reason)) {
            void failVoiceSession(reason)
          } else {
            void fallbackToBrowser(reason)
          }
        }
      })
      socket.addEventListener('error', () => {
        if (!conversationIsCurrent() || socketRef.current !== socket) return
        void fallbackToBrowser('Không mở được kết nối thoại bảo mật. Kiểm tra mạng rồi thử lại nhé.')
      })
      socket.addEventListener('close', () => {
        if (conversationIsCurrent() && socketRef.current === socket && voiceModeRef.current === 'realtime') {
          void fallbackToBrowser('Kết nối thoại cloud đã đóng.')
        }
      })
      await new Promise((resolve, reject) => {
        let settled = false
        let timeout = null
        const cleanup = () => {
          if (timeout) window.clearTimeout(timeout)
          socket.removeEventListener('open', onOpen)
          socket.removeEventListener('error', onError)
          socket.removeEventListener('close', onClose)
        }
        const settle = (callback, value) => {
          if (settled) return
          settled = true
          cleanup()
          callback(value)
        }
        const onOpen = () => settle(resolve)
        const onError = () => settle(reject, new Error('Không kết nối được dịch vụ thoại cloud.'))
        const onClose = () => settle(reject, new Error('Kết nối cloud đã đóng trước khi sẵn sàng.'))
        timeout = window.setTimeout(
          () => settle(reject, new Error('Kết nối cloud hết thời gian chờ.')),
          12000,
        )
        socket.addEventListener('open', onOpen)
        socket.addEventListener('error', onError)
        socket.addEventListener('close', onClose)
        if (socket.readyState === WebSocket.OPEN) onOpen()
        else if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) onClose()
      })
      if (!conversationIsCurrent()) return
    } catch (err) {
      if (!conversationIsCurrent()) return
      if (browserFallbackPromise) {
        await browserFallbackPromise
      } else if (voiceModeRef.current === 'realtime') {
        await fallbackToBrowser(`Nova-3 realtime gặp lỗi. ${voiceError(err)}`)
      } else {
        stopBrowserRecognition()
        await failVoiceSession(voiceError(err))
      }
    }
  }

  const stopConversation = async () => {
    if (stopPromiseRef.current) return stopPromiseRef.current
    const stopTask = (async () => {
      const stoppingSessionToken = ++voiceSessionTokenRef.current
      voiceTraceRef.current = null
      const socket = socketRef.current
      turnAbortRef.current?.abort()
      transition('stopping')
      continuousRecorderModeRef.current = false
      setRecordingQuestion(false)
      assistantSpeakingRef.current = false
      assistantDoneRef.current = false
      micResumePendingRef.current = false
      assistantReplyIdRef.current = null
      playbackAckSentRef.current = false
      cancelDeviceSpeech()
      if (socket?.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'stop' })) } catch {}
        window.setTimeout(() => { try { socket.close() } catch {} }, 1400)
      } else {
        try { socket?.close() } catch {}
      }
      socketRef.current = null
      setSpeechOutputStatus('')
      await releaseMedia()
      if (stoppingSessionToken === voiceSessionTokenRef.current) transition('idle')
    })()
    stopPromiseRef.current = stopTask
    try { await stopTask } finally {
      if (stopPromiseRef.current === stopTask) stopPromiseRef.current = null
    }
  }

  const replayAnswer = () => {
    if (!answer.trim()) return
    cancelDeviceSpeech()
    setSpeechOutputStatus('')
    speakChunk(answer)
  }

  useEffect(() => () => {
    voiceSessionTokenRef.current += 1
    voiceTraceRef.current = null
    turnAbortRef.current?.abort()
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'stop' })) } catch {}
      try { socket.close() } catch {}
    }
    socketRef.current = null
    cancelDeviceSpeech()
    void releaseMedia()
    void releaseScreenWakeLock()
  }, [])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && stateRef.current !== 'idle' && stateRef.current !== 'error') {
        void acquireScreenWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  const statusLabel = {
    idle: 'ĐANG CHỜ',
    connecting: 'ĐANG KẾT NỐI',
    resuming: 'ĐANG MỞ LẠI MICRO',
    stopping: 'ĐANG DỪNG',
    recording: 'ĐANG GHI ÂM',
    transcribing: 'ĐANG NHẬN CHỮ',
    listening: 'ĐANG NGHE',
    speaking: 'ĐANG TRẢ LỜI',
    error: 'CÓ LỖI KẾT NỐI',
  }[sessionState] || 'ĐANG CHỜ'
  const canStart = sessionState === 'idle' || sessionState === 'error'
  const active = !canStart
  const canStartVoice = voiceMode !== 'none' || recordedQuestionReady || sessionState === 'error'
  const startButtonLabel = sessionState === 'error' ? 'Thử lại trò chuyện' : 'Bắt đầu trò chuyện'
  const micListeningLabel = sessionState !== 'listening'
    ? ''
    : voiceMode === 'browser' && !recordedTranscription
      ? 'trình duyệt đang nghe'
      : micSignal ? 'mic nhận được tiếng' : 'đang chờ giọng nói'

  return (
    <div className="voice-screen page-pad">
      <header className="subpage-top">
        <button className="back-button" disabled={sessionState === 'stopping'} onClick={() => {
          if (stateRef.current === 'idle') onBack()
          else void stopConversation().then(() => onBack())
        }}><ArrowLeft size={21} />Về trang chính</button>
        <span className={'live-state ' + (sessionState === 'recording' || sessionState === 'transcribing' || sessionState === 'listening' || sessionState === 'speaking' || sessionState === 'resuming' ? 'live-state--on' : '')}><span />{statusLabel}</span>
      </header>
      <div className="voice-heading">
        <p className="eyebrow">TRÒ CHUYỆN GIỌNG NÓI · TIẾNG VIỆT</p>
        <h1>Mình nghe<br /><em>bạn nói.</em></h1>
        <p>{sessionState === 'resuming'
          ? 'Đang mở lại micro để nhận câu hỏi tiếp theo…'
          : sessionState === 'recording'
          ? 'App tự cân nền mic, chờ bạn nói và kết thúc lượt sau một khoảng lặng; rồi trả lời thành tiếng và nghe tiếp.'
          : sessionState === 'transcribing'
            ? `Đang chuyển lời nói thành chữ bằng ${recordedSttLabel}; sau câu trả lời app sẽ tự nghe lượt tiếp theo.`
            : recordedTranscription
              ? `Nói tự nhiên, không cần bấm lại sau mỗi lượt. App tự cân nền mic; ${recordedSttLabel} nhận câu hỏi và ${assistantModelLabel} trả lời thành tiếng.`
              : voiceMode === 'realtime'
                ? `Âm thanh được truyền lên ${capabilities?.voice_realtime_provider === 'elevenlabs' ? 'ElevenLabs Scribe' : 'cloud'} để nhận chữ; ${assistantModelLabel} tạo câu trả lời${capabilities?.voice_tts_ready ? ', VieNeu-TTS tự host tạo audio tiếng Việt' : ', app đang dùng TTS hiện có'}. App nghe lại sau khi đọc xong; giữ trang ở phía trước trong lúc trò chuyện.`
                : voiceMode === 'recorded'
                  ? `${recordedSttLabel} nhận câu tiếng Việt trên máy chủ; ${assistantModelLabel} tạo câu trả lời. Nếu bật camera, app gửi một khung hình mới cùng câu hỏi.`
                : voiceMode === 'browser'
                  ? `${browserSpeechLabel} nhận câu tiếng Việt; ${assistantModelLabel} tạo câu trả lời. Nếu bật camera, app gửi một khung hình mới cùng câu hỏi.`
                  : 'Dịch vụ hội thoại chưa sẵn sàng trên thiết bị này.'}</p>
      </div>

      <div className={cameraEnabled && active ? 'voice-camera voice-camera--active' : 'voice-camera'}>
        <video ref={videoRef} playsInline muted autoPlay aria-label="Camera thiết bị dùng làm ngữ cảnh tùy chọn cho câu hỏi thoại" />
        {(!cameraEnabled || !active) && <div className="voice-camera-placeholder"><Camera size={27} /><strong>{cameraEnabled ? 'Camera sẽ mở khi bắt đầu' : 'Camera đang tắt'}</strong><span>Chỉ gửi khung hình khi bạn bật camera.</span></div>}
        {cameraEnabled && active && <span className="voice-camera-badge"><span />NGỮ CẢNH CAMERA ĐANG BẬT</span>}
      </div>

      <div className="voice-controls">
        {sessionState === 'connecting' ? (
          <button className="voice-main-button" type="button" disabled>
            <SpinnerGap size={23} className="voice-spin" />
            <span>Đang kết nối…</span>
          </button>
        ) : !active ? (
          <button className="voice-main-button" disabled={!canStartVoice || sessionState === 'connecting'} onClick={() => void startConversation()}>
            <Microphone size={23} />
            <span>{startButtonLabel}</span>
          </button>
        ) : (
          <button className="voice-main-button voice-main-button--stop" disabled={sessionState === 'stopping'} onClick={() => void stopConversation()}>
            {sessionState === 'stopping' ? <SpinnerGap size={23} className="voice-spin" /> : <MicrophoneSlash size={23} />}
            <span>{sessionState === 'stopping' ? 'Đang kết thúc…' : 'Kết thúc cuộc trò chuyện'}</span>
          </button>
        )}
        <button className={'voice-camera-toggle ' + (cameraEnabled ? 'is-on' : '')} type="button" disabled={active} onClick={() => setCameraEnabled((current) => !current)}>
          {cameraEnabled ? <Camera size={20} /> : <CameraSlash size={20} />}
          <span>{cameraEnabled ? 'Camera bật' : 'Bật camera'}</span>
        </button>
      </div>

      {contextTurnsLoaded > 0 && <p className="voice-model-note">Đang nối tiếp {contextTurnsLoaded} lượt hỏi–đáp chữ gần đây trong hồ sơ này. Ảnh và âm thanh cũ không được nạp lại.</p>}
      {error && <div className="voice-error" role="alert">{error}</div>}
      {(speechOutputStatus || capabilities?.voice_tts_note) && <p className="voice-model-note" role="status">{speechOutputStatus || capabilities?.voice_tts_note}</p>}
      {voiceMode === 'none' && !recordedQuestionReady && <div className="voice-error" role="note">Không có dịch vụ thoại hoặc phiên âm khả dụng trên máy chủ hiện tại.</div>}

      <section className="voice-transcript" aria-live="polite">
        <div className="voice-section-title"><Microphone size={18} /><strong>Bạn vừa nói</strong><span>{micListeningLabel}</span></div>
        <p>{transcript || (recordingQuestion ? 'Đang ghi âm câu hỏi…' : sessionState === 'resuming' ? 'Đang mở lại micro…' : sessionState === 'transcribing' ? 'Đang chuyển thành chữ…' : sessionState === 'listening' ? 'Mình đang nghe…' : 'Nội dung lời nói sẽ hiện ở đây.')}</p>
      </section>
      <section className="voice-answer" aria-live="polite">
        <div className="voice-section-title"><SpeakerHigh size={18} /><strong>Trả lời</strong><span>{sessionState === 'speaking' ? 'đang trả lời' : ''}{answer.trim() && <button type="button" className="voice-speech-button" onClick={replayAnswer}>Nghe lại</button>}</span></div>
        <p>{answer || (capabilities?.voice_tts_ready
          ? 'Câu trả lời sẽ được đọc thành tiếng bằng VieNeu-TTS tự host.'
          : 'Câu trả lời sẽ được đọc thành tiếng trên thiết bị này.')}</p>
      </section>

      {lastVoiceMetrics && <p className="voice-model-note">
        Đo lượt thoại gần nhất trên trình duyệt: {lastVoiceMetrics.captureMs !== null ? `thu ${formatVoiceLatency(lastVoiceMetrics.captureMs)}; ` : ''}{lastVoiceMetrics.transcriptionRoundTripMs !== null ? `phiên âm ${formatVoiceLatency(lastVoiceMetrics.transcriptionRoundTripMs)}; ` : ''}{lastVoiceMetrics.transcriptionProvider ? `${lastVoiceMetrics.transcriptionProvider}${lastVoiceMetrics.transcriptionModel ? ` / ${lastVoiceMetrics.transcriptionModel}` : ''}; ` : ''}AI ra chữ đầu {formatVoiceLatency(lastVoiceMetrics.modelFirstTokenMs)}; AI hoàn tất {formatVoiceLatency(lastVoiceMetrics.modelTotalMs)}; {lastVoiceMetrics.stopToFirstSpeechMs !== null ? `từ dừng mic đến lúc thiết bị đọc ${formatVoiceLatency(lastVoiceMetrics.stopToFirstSpeechMs)}` : `từ transcript cuối đến lúc thiết bị đọc ${formatVoiceLatency(lastVoiceMetrics.transcriptToFirstSpeechMs)}`}. Mốc phản hồi ≤2 giây {((lastVoiceMetrics.stopToFirstSpeechMs ?? lastVoiceMetrics.transcriptToFirstSpeechMs) !== null) ? ((lastVoiceMetrics.stopToFirstSpeechMs ?? lastVoiceMetrics.transcriptToFirstSpeechMs) <= 2000 ? 'đạt' : 'chưa đạt') : 'chưa đo'}; thời gian cloud gồm cả mạng.
      </p>}

      <div className="voice-cloud-note"><WifiHigh size={17} /><p>{recordedTranscription
        ? `Khi dùng nhánh dự phòng, app tự ước lượng tiếng nền, lọc âm nhỏ và kết thúc lượt sau khoảng 0,7 giây yên lặng; ${recordedSttLabel} nhận từng câu. Audio không lưu vào Lịch sử; câu hỏi và câu trả lời dạng chữ có thể được lưu.`
        : voiceMode === 'realtime'
          ? `Micro tự ước lượng tiếng nền và chỉ gửi khung có giọng nói tới ${realtimeSttLabel}; máy chủ lọc âm nền và chốt câu sau khoảng 0,55 giây yên lặng. Khi đọc câu trả lời, app tạm ngừng gửi mic để tránh nhận nhầm tiếng loa. Audio không lưu thành tệp.`
          : `${browserSpeechLabel} nhận câu tiếng Việt; app gửi phần chữ nhận được tới ${assistantModelLabel}. Ảnh chỉ gửi khi bật camera. App không lưu audio; câu hỏi và câu trả lời chữ được lưu trong Lịch sử.`} {capabilities?.voice_tts_ready ? 'Giọng đọc do VieNeu-TTS tự host tạo trên máy chủ.' : 'Giọng đọc dùng chức năng có sẵn trên thiết bị.'}</p></div>
      <p className="voice-model-note">{recordedTranscription
        ? `${recordedSttLabel} → ${assistantModelLabel} → ${getVoiceTtsRouteLabel(capabilities?.voice_tts_ready, capabilities?.voice_tts_provider)}.`
        : voiceMode === 'realtime'
          ? `${realtimeSttLabel} nghe liên tục → ${realtimeAssistantLabel} trả lời theo luồng → ${getVoiceTtsRouteLabel(capabilities?.voice_tts_ready, capabilities?.voice_tts_provider)}. App tiếp tục nghe sau câu trả lời.`
          : `${browserSpeechLabel} → ${assistantModelLabel} → ${getVoiceTtsRouteLabel(capabilities?.voice_tts_ready, capabilities?.voice_tts_provider)}.`}</p>
    </div>
  )
}
