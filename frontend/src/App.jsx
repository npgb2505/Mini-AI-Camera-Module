import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import assistantProfile from '../../assistant_profile.json'
import { getCameraLifecycleAnnouncement } from './camera-lifecycle-announcement.js'
import { getVoiceReadiness } from './voice-capability.js'
import { createPendingDeviceButtonAction, shouldClaimCloudAskButtonEvent, shouldUseDeviceBrowserSpeechRecognition } from './device-button-action.js'
import { cloudDeviceStateLabel, formatDeviceClaimCommand, formatDeviceClaimExpiry, isFreshCloudDeviceEvent } from './device-cloud-pairing.js'
import {
  deviceDetectionMatchesFrame,
  isDeviceDetectionAgeFresh,
} from './device-detection-freshness.js'
import { createSessionOwner, stopMediaStreamIfStale } from './device-session-lifecycle.js'
import {
  appendGuidanceState,
  getGuidanceCue,
  isGuidanceStable,
} from './guidance-alert-policy.js'
import {
  getPathClientAgeAtResponseMs,
  isPathResultFresh,
  pathResponseMatches,
} from './path-result-freshness.js'
import {
  isActiveCurrentCameraStream,
  shouldHandleCameraTrackEnd,
} from './camera-stream-lifecycle.js'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle,
  ClockCounterClockwise,
  Cpu,
  Eye,
  EyeSlash,
  FileImage,
  House,
  ImageSquare,
  Info,
  LockKey,
  Microphone,
  MicrophoneSlash,
  Moon,
  Signpost,
  PaperPlaneTilt,
  SignOut,
  SlidersHorizontal,
  Sparkle,
  SpeakerHigh,
  SpinnerGap,
  Sun,
  Trash,
  UserCircle,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  X,
} from '@phosphor-icons/react'
const CloudVoiceScreen = lazy(() => import('./CloudVoiceScreen'))

const CONNECTION_ERROR_MESSAGE = 'Không kết nối được máy chủ app. Kiểm tra máy chủ còn chạy và điện thoại/máy tính đang dùng đúng kết nối mạng, rồi thử lại nhé.'
const TIMEOUT_ERROR_MESSAGE = 'Máy chủ đang xử lý quá lâu. Kiểm tra kết nối rồi thử lại nhé.'
const DEFAULT_REQUEST_TIMEOUT_MS = 15000
const MAX_HANDLED_BUTTON_EVENTS = 128
const HANDLED_BUTTON_EVENTS_STORAGE_KEY = 'roSight.handledDeviceButtonEvents.v1'

function speechRecognitionConstructor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function hasBrowserSpeechRecognition() {
  return Boolean(speechRecognitionConstructor())
}

function speechRecognitionErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Safari chưa được phép nhận giọng nói. Kiểm tra quyền Microphone và bật Siri trong Cài đặt iPhone.'
    case 'audio-capture':
      return 'Không mở được micro iPhone. Kiểm tra quyền Microphone trong Safari rồi thử lại.'
    case 'language-not-supported':
      return 'Safari chưa hỗ trợ nhận dạng tiếng Việt trên máy này. Dùng mic Dictation trên bàn phím.'
    case 'network':
      return 'Dịch vụ nhận giọng nói của Safari chưa sẵn sàng. Dùng mic Dictation trên bàn phím rồi gửi lại.'
    case 'no-speech':
      return 'Chưa nghe được câu hỏi. Nói gần mic hơn rồi thử lại.'
    default:
      return 'Chưa nhận được câu hỏi. Dùng mic Dictation trên bàn phím hoặc thử lại.'
  }
}

function connectionError(error) {
  if (error?.name === 'AbortError') return error
  return new Error(CONNECTION_ERROR_MESSAGE)
}

function cameraErrorMessage(error) {
  switch (error?.name) {
    case 'TimeoutError':
      return 'Safari chưa xác nhận quyền camera trong 20 giây. Đóng lời nhắc còn mở rồi thử lại.'
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Safari chưa được phép dùng camera. Bật quyền Camera trong cài đặt Safari rồi thử lại.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Không tìm thấy camera sau trên thiết bị này.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Camera đang bận hoặc chưa sẵn sàng. Đóng ứng dụng khác đang dùng camera rồi thử lại.'
    case 'SecurityError':
      return 'Camera cần trang HTTPS an toàn. Mở app bằng Safari qua HTTPS rồi thử lại.'
    case 'OverconstrainedError':
      return 'Không mở được camera với cài đặt hiện tại. Thử tải lại trang rồi mở lại camera.'
    default:
      return 'Chưa mở được camera. Kiểm tra quyền Camera trong Safari rồi thử lại.'
  }
}

function cameraUnavailableMessage() {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'Camera iPhone cần kết nối HTTPS an toàn. Mở ứng dụng bằng Safari qua liên kết HTTPS rồi thử lại.'
  }
  return 'Trình duyệt chưa hỗ trợ camera trực tiếp.'
}

function getUserMediaWithTimeout(constraints, { signal, timeoutMs = 20000 } = {}) {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    const error = new Error(cameraUnavailableMessage())
    error.name = 'SecurityError'
    return Promise.reject(error)
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error(cameraUnavailableMessage()))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let timeoutId
    const cleanup = () => {
      window.clearTimeout(timeoutId)
      signal?.removeEventListener('abort', abortFromCaller)
    }
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abortFromCaller = () => {
      const error = new Error('Camera startup was cancelled.')
      error.name = 'AbortError'
      rejectOnce(error)
    }

    if (signal?.aborted) {
      abortFromCaller()
      return
    }
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    timeoutId = window.setTimeout(() => {
      const error = new Error('Camera permission response timed out.')
      error.name = 'TimeoutError'
      rejectOnce(error)
    }, timeoutMs)

    Promise.resolve()
      .then(() => navigator.mediaDevices.getUserMedia(constraints))
      .then((stream) => {
        if (settled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        settled = true
        cleanup()
        resolve(stream)
      })
      .catch((error) => rejectOnce(error))
  })
}

function microphoneErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return 'Chưa cấp quyền micro. Bạn có thể dùng mic Dictation trên bàn phím iPhone.'
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'Không tìm thấy micro. Bạn có thể dùng mic Dictation trên bàn phím iPhone.'
  }
  if (error?.name === 'NotSupportedError') {
    return 'Trình duyệt chưa hỗ trợ định dạng ghi âm này. Bạn có thể dùng mic Dictation trên bàn phím iPhone.'
  }
  return 'Chưa mở được micro. Kiểm tra quyền micro trong Safari hoặc dùng mic Dictation trên bàn phím iPhone.'
}

async function fetchApp(input, options = {}) {
  const { signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...requestOptions } = options
  const controller = new AbortController()
  let timedOut = false
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromCaller = () => controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (signal?.aborted) abortFromCaller()
  try {
    return await fetch(input, { ...requestOptions, signal: controller.signal })
  } catch (error) {
    if (signal?.aborted) throw error
    if (timedOut) throw new Error(TIMEOUT_ERROR_MESSAGE)
    throw connectionError(error)
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

async function api(path, options = {}) {
  const response = await fetchApp(path, { credentials: 'same-origin', ...options })
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : ''
    if (/failed to fetch/i.test(message)) throw new Error(CONNECTION_ERROR_MESSAGE)
    const error = new Error(message || 'Có lỗi xảy ra. Bạn thử lại nhé.')
    error.status = response.status
    throw error
  }
  return payload
}

function downscaleAsJpeg(file, maxSide = 1280, quality = 0.84) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Không tạo được bộ xử lý ảnh trên trình duyệt.')
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url)
          if (!blob) return reject(new Error('Không chuyển được ảnh sang JPEG.'))
          resolve(new File([blob], 'segformer-frame.jpg', { type: 'image/jpeg' }))
        }, 'image/jpeg', quality)
      } catch (error) {
        URL.revokeObjectURL(url)
        reject(error)
      }
    }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Trình duyệt không đọc được ảnh đã chọn.')) }
    image.src = url
  })
}

function loadHandledButtonEvents() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(HANDLED_BUTTON_EVENTS_STORAGE_KEY) || '[]')
    if (!Array.isArray(stored)) return new Set()
    return new Set(stored.filter((key) => typeof key === 'string').slice(-MAX_HANDLED_BUTTON_EVENTS))
  } catch {
    return new Set()
  }
}

function rememberHandledButtonEvent(handled, eventKey) {
  if (handled.has(eventKey)) return false
  handled.add(eventKey)
  while (handled.size > MAX_HANDLED_BUTTON_EVENTS) {
    handled.delete(handled.values().next().value)
  }
  try {
    window.localStorage.setItem(HANDLED_BUTTON_EVENTS_STORAGE_KEY, JSON.stringify([...handled]))
  } catch {
    // Keep in-memory deduplication when browser storage is unavailable.
  }
  return true
}

const json = (data) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
})

const DEVICE_CONTEXT_TTL_MS = 350
const CAMERA_FRAME_TTL_MS = 1000
const CLOUD_DEVICE_CONTEXT_TTL_MS = 1650

function readOperationEnabled(status) {
  if (typeof status?.operation_enabled === 'boolean') return status.operation_enabled
  if (typeof status?.device_health?.operation_enabled === 'boolean') return status.device_health.operation_enabled
  if (typeof status?.button_event?.operation_enabled === 'boolean') return status.button_event.operation_enabled
  return null
}

function deviceOperationPauseMessage(status) {
  const health = status?.device_health
  const profile = health?.pin_profile
  if (health?.mode_button_configured === false || health?.button_inputs_configured === false) {
    const inputReason = health.mode_button_configured === false
      ? 'GPIO nút MODE chưa được cấu hình'
      : 'GPIO nút vào chưa được cấu hình'
    const details = [
      profile?.id ? `profile ${profile.id}` : '',
      profile?.camera_map_status ? `camera map ${profile.camera_map_status}` : '',
      profile?.external_map_status ? `external map ${profile.external_map_status}` : '',
    ].filter(Boolean)
    const profileNote = details.length ? ` (${details.join('; ')}).` : ''
    return `ESP32 giữ standby sau reset vì ${inputReason}.${profileNote} App không có lệnh bật từ xa; status/mạng vẫn dùng được, còn capture, inference, ToF, cảnh báo và Vision bị khóa.`
  }
  if (health?.mode_button_configured === true) {
    return 'ESP32 đang tạm dừng. Có thể bật bằng nút MODE vật lý đã cấu hình; app không có lệnh bật từ xa.'
  }
  return 'ESP32 đang tạm dừng. Chưa xác nhận GPIO nút MODE và app không có lệnh bật từ xa; status/mạng vẫn dùng được.'
}

function Brand({ compact = false }) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="Rõ — Nhìn cùng bạn">
      <span className="brand-mark"><Eye size={23} weight="duotone" aria-hidden="true" /></span>
      <span className="brand-word">Rõ<span className="brand-period">.</span></span>
      {!compact && <span className="brand-caption">NHÌN CÙNG BẠN</span>}
    </div>
  )
}

function ActionButton({ children, icon: Icon, tone = 'dark', className = '', ...props }) {
  return (
    <button
      type="button"
      className={`action-button action-button--${tone} ${className}`}
      {...props}
    >
      {Icon && <Icon size={21} weight="bold" aria-hidden="true" />}
      <span>{children}</span>
    </button>
  )
}

function BottomNav({ active, onChange }) {
  const items = [
    { id: 'home', label: 'Trang chính', Icon: House },
    { id: 'live', label: 'Lối đi', Icon: Signpost },
    { id: 'history', label: 'Lịch sử', Icon: ClockCounterClockwise },
    { id: 'profile', label: 'Hồ sơ', Icon: UserCircle },
  ]
  return (
    <nav className="bottom-nav" aria-label="Điều hướng chính">
      {items.map(({ id, label, Icon }) => (
        <button key={id} className={`nav-item ${active === id ? 'is-active' : ''}`} onClick={() => onChange(id)} aria-current={active === id ? 'page' : undefined}>
          <Icon size={23} weight={active === id ? 'fill' : 'regular'} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}

function App() {
  const accountSessionOwnerRef = useRef(null)
  if (accountSessionOwnerRef.current === null) accountSessionOwnerRef.current = createSessionOwner()
  const accountSessionOwner = accountSessionOwnerRef.current
  const accountSessionToken = accountSessionOwner.current()
  const [booting, setBooting] = useState(true)
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [capabilities, setCapabilities] = useState(null)
  const [capabilitiesError, setCapabilitiesError] = useState('')
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false)
  const [startupError, setStartupError] = useState('')
  const [bootstrapRetry, setBootstrapRetry] = useState(0)
  const [view, setView] = useState('home')
  const viewRef = useRef(view)
  viewRef.current = view
  const recordingSessionOwnerRef = useRef(null)
  if (recordingSessionOwnerRef.current === null) recordingSessionOwnerRef.current = createSessionOwner()
  const appMicRequestRef = useRef(null)
  const speechContextRef = useRef(null)
  const speechSourceRef = useRef(null)
  const appRecorderRef = useRef(null)
  const appRecorderStreamRef = useRef(null)
  const photoUrlRef = useRef(null)
  const [operationEnabled, setOperationEnabled] = useState(null)
  const [deviceConnection, setDeviceConnection] = useState(null)
  const [deviceError, setDeviceError] = useState('')
  const [deviceUpdatedAt, setDeviceUpdatedAt] = useState(null)
  const [pendingButtonActions, setPendingButtonActions] = useState([])
  const [capturedDeviceFrame, setCapturedDeviceFrame] = useState(null)
  const [authMode, setAuthMode] = useState('register')
  const [toast, setToast] = useState('')
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [photo, setPhoto] = useState(null)
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const capturedDeviceFrameUrlRef = useRef(null)
  const profileSaveInFlightRef = useRef(false)
  const handledButtonEventsRef = useRef(null)
  const historyRequestRef = useRef(0)
  if (handledButtonEventsRef.current === null) {
    handledButtonEventsRef.current = loadHandledButtonEvents()
  }
  const devicePollInFlightRef = useRef(false)
  const refreshCapabilities = useCallback(async () => {
    setCapabilitiesLoading(true)
    try {
      setCapabilities(await api('/api/status'))
      setCapabilitiesError('')
    } catch (error) {
      setCapabilities(null)
      setCapabilitiesError(error.message || CONNECTION_ERROR_MESSAGE)
    } finally {
      setCapabilitiesLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    Promise.allSettled([
      api('/api/auth/me'),
      api('/api/status'),
    ]).then(([accountResult, statusResult]) => {
      if (!alive) return
      if (accountResult.status === 'fulfilled' && accountResult.value?.user) {
        const account = accountResult.value
        setUser(account.user)
        setProfile(account.profile)
      } else if (accountResult.status === 'rejected' && accountResult.reason?.status !== 401) {
        setStartupError(accountResult.reason?.message || CONNECTION_ERROR_MESSAGE)
      }
      if (statusResult.status === 'fulfilled') {
        setCapabilities(statusResult.value)
        setCapabilitiesError('')
      } else {
        setCapabilities(null)
        setCapabilitiesError(statusResult.reason?.message || CONNECTION_ERROR_MESSAGE)
      }
      setBooting(false)
    })
    return () => { alive = false }
  }, [bootstrapRetry])

  useEffect(() => {
    const scale = Number(profile?.text_scale || 1)
    document.documentElement.style.setProperty('--text-scale', String(scale))
    document.documentElement.dataset.contrast = profile?.high_contrast ? 'high' : 'soft'
  }, [profile])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [view, user])

  useEffect(() => {
    const url = capturedDeviceFrame?.url
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [capturedDeviceFrame?.url])

  useEffect(() => {
    if (!user) return undefined
    let alive = true
    const refreshDevice = async () => {
      if (devicePollInFlightRef.current) return
      devicePollInFlightRef.current = true
      try {
        const next = await api('/api/device/status')
        if (!alive) return
        setDeviceConnection(next)
        setDeviceError('')
        setDeviceUpdatedAt(performance.now())
        const statusOperationEnabled = readOperationEnabled(next?.status)
        setOperationEnabled(statusOperationEnabled)

        const eventRecords = Array.isArray(next?.status?.button_events)
          ? next.status.button_events
          : next?.status?.button_event
            ? [{ event: next.status.button_event, age_ms: next.status.button_event_age_ms }]
            : []
        for (const record of eventRecords) {
          let event = record?.event || record
          let eventAge = Number.isInteger(record?.age_ms)
            ? record.age_ms
            : next?.status?.button_event_age_ms
          if (!event || !Number.isInteger(eventAge) || eventAge < 0 || eventAge > 10000) continue
          if (!['mode', 'capture_image', 'ask_llm'].includes(event.button_id) || event.action !== 'pressed'
              || typeof event.device_id !== 'string' || !event.device_id
              || typeof event.boot_id !== 'string' || !event.boot_id
              || !Number.isInteger(event.press_id) || event.press_id < 1 || event.press_id > 4294967295
              || typeof event.operation_enabled !== 'boolean') continue
          if (shouldClaimCloudAskButtonEvent(next?.transport, event)) {
            const claim = await api('/api/device/button/claim', json({ event_id: event.event_id }))
            if (!alive || claim?.claimed !== true || !claim.event) continue
            event = claim.event
            eventAge = claim.event_age_ms
            if (!Number.isInteger(eventAge) || eventAge < 0 || eventAge > 10000) continue
          }
          const eventKey = JSON.stringify([event.device_id, event.boot_id, event.press_id])
          const handled = handledButtonEventsRef.current
          if (!rememberHandledButtonEvent(handled, eventKey)) continue

          if (event.button_id === 'mode') {
            const enabled = event.operation_enabled
            setOperationEnabled(enabled)
            setDeviceConnection((current) => current ? {
              ...current,
              status: { ...(current.status || {}), operation_enabled: enabled },
            } : current)
            setToast(enabled ? 'Thiết bị đã được bật.' : 'Thiết bị đang tạm dừng.')
            continue
          }

          const pendingAction = createPendingDeviceButtonAction({
            event,
            eventAgeMs: eventAge,
            operationEnabled: statusOperationEnabled,
            frameSeq: next?.status?.camera_frame,
            receivedAt: performance.now(),
          })
          if (!pendingAction) {
            const enabled = statusOperationEnabled ?? event.operation_enabled
            if (enabled !== true || event.operation_enabled !== true) {
              setToast(enabled === false || event.operation_enabled === false
                ? 'Thiết bị đang tạm dừng.'
                : 'Chưa xác nhận trạng thái hoạt động của ESP32.')
            }
            continue
          }
          setPendingButtonActions((current) => current.some((action) => action.key === pendingAction.key)
            ? current
            : [...current, pendingAction])
          setView('device')
          setToast(pendingAction.action === 'ask_llm'
            ? 'Đang mở micro để ghi câu hỏi từ nút thiết bị…'
            : 'Đang chụp ảnh mới từ camera ESP32…')
        }
      } catch (err) {
        if (!alive) return
        setDeviceConnection(null)
        setOperationEnabled(null)
        setDeviceError(err.message || 'Không kết nối được bridge thiết bị.')
      } finally {
        devicePollInFlightRef.current = false
      }
    }
    void refreshDevice()
    const timer = window.setInterval(refreshDevice, 1500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [user, view])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const enterApp = (account) => {
    accountSessionOwner.advance()
    recordingSessionOwnerRef.current.advance()
    appMicRequestRef.current = null
    document.activeElement?.blur?.()
    setUser(account.user)
    setProfile(account.profile)
    setView('home')
    setToast('Chào bạn, mình sẵn sàng rồi.')
  }

  const authenticate = async (form) => {
    const requestSessionToken = accountSessionOwner.current()
    const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login'
    const payload = await api(endpoint, json(form))
    if (!accountSessionOwner.owns(requestSessionToken)) return
    enterApp(payload)
  }

  const signOut = async () => {
    accountSessionOwner.advance()
    recordingSessionOwnerRef.current.advance()
    appMicRequestRef.current = null
    const recorder = appRecorderRef.current
    if (recorder) {
      const recorderStream = appRecorderStreamRef.current
      recorder.ondataavailable = null
      recorder.onstop = () => {
        if (appRecorderRef.current === recorder) appRecorderRef.current = null
        recorderStream?.getTracks().forEach((track) => { try { track.stop() } catch {} })
        if (appRecorderStreamRef.current === recorderStream) appRecorderStreamRef.current = null
        if (window.__roRecorder === recorder) window.__roRecorder = null
      }
      if (recorder.state !== 'inactive') { try { recorder.stop() } catch {} }
    }
    appRecorderStreamRef.current?.getTracks().forEach((track) => { try { track.stop() } catch {} })
    appRecorderStreamRef.current = null
    appRecorderRef.current = null
    window.__roRecorder = null
    historyRequestRef.current += 1
    if (capturedDeviceFrameUrlRef.current) URL.revokeObjectURL(capturedDeviceFrameUrlRef.current)
    capturedDeviceFrameUrlRef.current = null
    if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current)
    photoUrlRef.current = null
    setUser(null)
    setProfile(null)
    setHistory([])
    setHistoryError('')
    setHistoryLoading(false)
    setView('home')
    setDeviceConnection(null)
    setDeviceError('')
    setOperationEnabled(null)
    setPendingButtonActions([])
    setCapturedDeviceFrame(null)
    setPhoto(null)
    setResult(null)
    setQuestion('')
    setBusy(false)
    setRecording(false)
    setAuthMode('login')
    try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* local session can expire independently */ }
  }

  const openHistory = async () => {
    const requestNumber = ++historyRequestRef.current
    setHistory([])
    setHistoryError('')
    setHistoryLoading(true)
    setView('history')
    try {
      const payload = await api('/api/history')
      if (requestNumber === historyRequestRef.current) setHistory(payload.items || [])
    } catch (error) {
      if (requestNumber === historyRequestRef.current) {
        setHistoryError(error.message || 'Chưa tải được lịch sử. Kiểm tra kết nối rồi thử lại.')
      }
    } finally {
      if (requestNumber === historyRequestRef.current) setHistoryLoading(false)
    }
  }

  const clearPendingButtonAction = useCallback((key) => {
    setPendingButtonActions((current) => current[0]?.key === key
      ? current.slice(1)
      : current.filter((action) => action.key !== key))
  }, [])

  const saveDeviceJpeg = useCallback((blob, frameSeq, expectedSessionToken) => {
    if (!accountSessionOwner.owns(expectedSessionToken)) return
    if (!blob || blob.type !== 'image/jpeg') return
    if (capturedDeviceFrameUrlRef.current) URL.revokeObjectURL(capturedDeviceFrameUrlRef.current)
    const url = URL.createObjectURL(blob)
    capturedDeviceFrameUrlRef.current = url
    setCapturedDeviceFrame({ blob, url, frameSeq, capturedAt: Date.now() })
    setToast(`Đã giữ JPEG khung ${frameSeq}. Bạn có thể tải ảnh về thiết bị.`)
  }, [accountSessionOwner])

  const updateProfile = async (next) => {
    if (profileSaveInFlightRef.current) return
    const sessionToken = accountSessionOwner.current()
    profileSaveInFlightRef.current = true
    setSavingProfile(true)
    const previous = profile
    setProfile(next)
    try {
      const payload = await api('/api/profile', { ...json(next), method: 'PUT' })
      if (accountSessionOwner.owns(sessionToken)) setProfile(payload.profile)
    } catch (error) {
      if (accountSessionOwner.owns(sessionToken)) {
        setProfile(previous)
        setToast(error.message)
      }
    } finally {
      profileSaveInFlightRef.current = false
      if (accountSessionOwner.owns(sessionToken)) setSavingProfile(false)
    }
  }

  const setPhotoFromBlob = (blob) => {
    if (!accountSessionOwner.owns(accountSessionToken) || viewRef.current !== 'capture') return
    if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current)
    const url = URL.createObjectURL(blob)
    photoUrlRef.current = url
    setPhoto({ blob, url })
    setQuestion('')
    setResult(null)
    setView('review')
  }

  const analyzePhoto = async () => {
    if (!photo?.blob) return
    const sessionToken = accountSessionOwner.current()
    setBusy(true)
    try {
      const body = new FormData()
      body.append('image', photo.blob, 'photo.jpg')
      body.append('question', question.trim())
      const payload = await api('/api/analyze', { method: 'POST', body, timeoutMs: 200000 })
      if (!accountSessionOwner.owns(sessionToken)) return
      setResult(payload)
      setView('result')
      if (profile?.speak_answers) speak(payload.answer)
    } catch (error) {
      if (accountSessionOwner.owns(sessionToken)) setToast(error.message)
    } finally { if (accountSessionOwner.owns(sessionToken)) setBusy(false) }
  }

  const speak = (text) => {
    if (capabilities?.voice_tts_ready && text) {
      const context = speechContextRef.current || new window.AudioContext()
      speechContextRef.current = context
      const previous = speechSourceRef.current
      speechSourceRef.current = null
      if (previous) { previous.onended = null; try { previous.stop() } catch {} }
      void (async () => {
        try {
          await context.resume()
          const response = await fetch('/api/voice/synthesize', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          if (!response.ok) {
            const payload = await response.json().catch(() => null)
            throw new Error(payload?.error || 'Máy chủ chưa tạo được giọng đọc.')
          }
          const audioBuffer = await context.decodeAudioData(await response.arrayBuffer())
          const source = context.createBufferSource()
          source.buffer = audioBuffer
          source.connect(context.destination)
          source.onended = () => { if (speechSourceRef.current === source) speechSourceRef.current = null }
          speechSourceRef.current = source
          source.start(0)
        } catch (error) {
          setToast(error?.message || 'Không phát được audio TTS từ máy chủ.')
        }
      })()
      return
    }
    if (!text || !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') {
      setToast('Chức năng đọc chưa được hỗ trợ trong trình duyệt này.')
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'vi-VN'
    utterance.rate = Number(profile?.voice_rate || 0.92)
    utterance.onerror = (event) => {
      if (event.error !== 'canceled' && event.error !== 'interrupted') {
        setToast('Trình duyệt chưa phát được câu trả lời. Kiểm tra âm lượng rồi thử lại nhé.')
      }
    }
    try {
      window.speechSynthesis.speak(utterance)
    } catch {
      setToast('Trình duyệt chưa phát được câu trả lời. Kiểm tra âm lượng rồi thử lại nhé.')
    }
  }

  const useTranscript = async (blob, expectedAccountToken, expectedRecordingToken) => {
    const accountToken = expectedAccountToken ?? accountSessionOwner.current()
    const recordingToken = expectedRecordingToken ?? recordingSessionOwnerRef.current.current()
    const isCurrent = () => accountSessionOwner.owns(accountToken)
      && recordingSessionOwnerRef.current.owns(recordingToken)
      && viewRef.current === 'review'
    if (!isCurrent()) return
    if (!capabilities?.transcription_ready) {
      setToast('Ghi âm trong app cần kết nối API. Bạn có thể dùng mic trên bàn phím iPhone để nhập câu hỏi.')
      return
    }
    const body = new FormData()
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm'
    body.append('audio', blob, `question.${extension}`)
    try {
      const payload = await api('/api/transcribe', { method: 'POST', body, timeoutMs: 45000 })
      if (!isCurrent()) return
      setQuestion(payload.text || '')
      if (payload.text) setToast('Đã nhận câu hỏi. Bạn xem lại rồi gửi nhé.')
    } catch (error) { if (isCurrent()) setToast(error.message) }
  }

  const startRecording = async () => {
    const accountToken = accountSessionOwner.current()
    const recordingToken = recordingSessionOwnerRef.current.current()
    const isCurrent = () => accountSessionOwner.owns(accountToken)
      && recordingSessionOwnerRef.current.owns(recordingToken)
      && viewRef.current === 'review'
    if (!isCurrent() || appMicRequestRef.current !== null || appRecorderRef.current?.state === 'recording') return
    if (!capabilities?.transcription_ready) {
      setToast('Bạn có thể dùng mic trên bàn phím iPhone. Ghi âm trong app cần cấu hình API trên máy chủ.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setToast('Trình duyệt này chưa hỗ trợ ghi âm. Bạn vẫn có thể gõ câu hỏi.')
      return
    }
    let stream
    const micRequestOwner = { accountToken, recordingToken }
    appMicRequestRef.current = micRequestOwner
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (stopMediaStreamIfStale(stream, isCurrent)) return
      const supportedType = typeof MediaRecorder.isTypeSupported === 'function'
        ? ['audio/webm;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type))
        : null
      const recorder = supportedType
        ? new MediaRecorder(stream, { mimeType: supportedType })
        : new MediaRecorder(stream)
      const pieces = []
      appRecorderRef.current = recorder
      appRecorderStreamRef.current = stream
      recorder.ondataavailable = (event) => { if (event.data.size) pieces.push(event.data) }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => { try { track.stop() } catch {} })
        if (appRecorderRef.current === recorder) appRecorderRef.current = null
        if (appRecorderStreamRef.current === stream) appRecorderStreamRef.current = null
        if (window.__roRecorder === recorder) window.__roRecorder = null
        if (!isCurrent()) return
        setRecording(false)
        if (pieces.length) void useTranscript(new Blob(pieces, { type: recorder.mimeType || 'audio/webm' }), accountToken, recordingToken)
      }
      recorder.start()
      setRecording(true)
      window.setTimeout(() => {
        if (recorder.state === 'recording') { try { recorder.stop() } catch {} }
      }, 15000)
      window.__roRecorder = recorder
    } catch (error) {
      stream?.getTracks().forEach((track) => { try { track.stop() } catch {} })
      if (appRecorderStreamRef.current === stream) {
        appRecorderStreamRef.current = null
        appRecorderRef.current = null
      }
      if (isCurrent()) setToast(microphoneErrorMessage(error))
    } finally {
      if (appMicRequestRef.current === micRequestOwner) appMicRequestRef.current = null
    }
  }

  const stopRecording = () => {
    const recorder = appRecorderRef.current
    if (recorder?.state === 'recording') { try { recorder.stop() } catch {} }
  }

  useEffect(() => {
    if (view !== 'review') {
      recordingSessionOwnerRef.current.advance()
      appMicRequestRef.current = null
      const recorder = appRecorderRef.current
      if (recorder) {
        recorder.ondataavailable = null
        if (recorder.state !== 'inactive') { try { recorder.stop() } catch {} }
      }
      appRecorderStreamRef.current?.getTracks().forEach((track) => { try { track.stop() } catch {} })
      appRecorderStreamRef.current = null
      appRecorderRef.current = null
      if (window.__roRecorder === recorder) window.__roRecorder = null
      setRecording(false)
    }
  }, [view, recording])

  const clearHistory = async () => {
    const sessionToken = accountSessionOwner.current()
    try {
      await api('/api/history', { method: 'DELETE' })
      if (!accountSessionOwner.owns(sessionToken)) return
      setHistory([])
      setHistoryError('')
      setConfirmClear(false)
      setToast('Lịch sử đã được xóa.')
    } catch (error) {
      if (!accountSessionOwner.owns(sessionToken)) return
      setHistoryError(error.message || 'Chưa xóa được lịch sử. Kiểm tra kết nối rồi thử lại.')
      setConfirmClear(false)
    }
  }

  if (booting) return <div className="boot-screen"><Brand /><span className="boot-pulse" aria-label="Đang tải" /></div>
  if (startupError) return <div className="boot-screen"><Brand /><p className="boot-error" role="alert">{startupError}</p><ActionButton onClick={() => { setStartupError(''); setBooting(true); setBootstrapRetry((attempt) => attempt + 1) }}>Thử kết nối lại</ActionButton></div>

  return (
    <div className="app-shell" data-build="ro-20261101-navigation-class-metadata-v1">
      <main className="app-content" id="main-content">
        {!user ? (
          <AuthScreen mode={authMode} setMode={setAuthMode} onSubmit={authenticate} capabilities={capabilities} />
        ) : (
            <section key={view} className="screen screen--enter">
              {view === 'home' && <HomeScreen user={user} capabilities={capabilities} operationEnabled={operationEnabled} deviceConnection={deviceConnection} onLive={() => setView('live')} onVoice={() => setView('voice')} onDevice={() => setView('device')} onProfile={() => setView('profile')} />}
              {view === 'device' && <DeviceScreen capabilities={capabilities} connection={deviceConnection} error={deviceError} updatedAt={deviceUpdatedAt} operationEnabled={operationEnabled} pendingButtonAction={pendingButtonActions[0] || null} onPendingButtonActionHandled={clearPendingButtonAction} capturedDeviceFrame={capturedDeviceFrame} onCaptureDeviceFrame={saveDeviceJpeg} accountSessionOwner={accountSessionOwner} accountSessionToken={accountSessionToken} autoSpeak={Boolean(profile?.speak_answers)} onSpeak={speak} onBack={() => setView('home')} />}
              {view === 'live' && <LiveScreen capabilities={capabilities} onBack={() => setView('home')} />}
              {view === 'voice' && <Suspense fallback={<div className="voice-loading page-pad" role="status">Đang mở phần trò chuyện…</div>}><CloudVoiceScreen capabilities={capabilities} voiceRate={profile?.voice_rate} onBack={() => setView('home')} /></Suspense>}
              {view === 'capture' && <CaptureScreen onBack={() => setView('home')} onCaptured={setPhotoFromBlob} />}
              {view === 'review' && (
                <ReviewScreen
                  photo={photo}
                  question={question}
                  setQuestion={setQuestion}
                  busy={busy}
                  recording={recording}
                  onBack={() => setView('capture')}
                  onAnalyze={analyzePhoto}
                  onRecord={recording ? stopRecording : startRecording}
                  capabilities={capabilities}
                />
              )}
              {view === 'result' && <ResultScreen photo={photo} result={result} onBack={() => setView('home')} onSpeak={() => speak(result?.answer)} onAgain={() => setView('capture')} />}
              {view === 'history' && <HistoryScreen items={history} loading={historyLoading} error={historyError} onBack={() => setView('home')} onClear={() => setConfirmClear(true)} onRetry={() => void openHistory()} />}
              {view === 'profile' && <ProfileScreen user={user} profile={profile} capabilities={capabilities} capabilitiesError={capabilitiesError} refreshingCapabilities={capabilitiesLoading} saving={savingProfile} onBack={() => setView('home')} onUpdate={updateProfile} onSignOut={signOut} onRefresh={refreshCapabilities} onAdvanced={() => setView('ai-settings')} />}
              {view === 'ai-settings' && <ModelSettingsScreen onBack={() => setView('profile')} />}
            </section>
        )}
      </main>

      {user && ['home', 'live', 'history', 'profile'].includes(view) && <BottomNav active={view} onChange={(next) => next === 'history' ? void openHistory() : setView(next)} />}
      <div className="sr-only" role="status" aria-live="polite">{toast}</div>
      {toast && <div className="toast toast--enter" role="presentation"><Info size={18} />{toast}</div>}

      {confirmClear && <ConfirmDialog onCancel={() => setConfirmClear(false)} onConfirm={clearHistory} />}
    </div>
  )
}

function AuthScreen({ mode, setMode, onSubmit, capabilities }) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [registrationCode, setRegistrationCode] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSubmit({ display_name: name, username, password, registration_code: registrationCode })
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  const registering = mode === 'register'
  const usesCloudflareTunnel = window.location.hostname.endsWith('trycloudflare.com')
  return (
    <section className="auth-screen">
      <header className="auth-brand"><Brand /></header>
      <div className="auth-art" aria-hidden="true">
        <span className="auth-sun" /><span className="auth-leaf auth-leaf--one" /><span className="auth-leaf auth-leaf--two" />
        <div className="auth-eye"><Eye size={50} weight="duotone" /></div>
        <span className="art-star art-star--one">✳</span><span className="art-star art-star--two">✦</span>
      </div>
      <div className="auth-copy">
        <p className="eyebrow">MỘT NGƯỜI BẠN ĐỒNG HÀNH</p>
        <h1>{registering ? <>Cùng bạn<br /><em>nhìn rõ hơn.</em></> : <>Rất vui<br /><em>gặp lại bạn.</em></>}</h1>
        <p className="body-copy">Chụp một khoảnh khắc. Rõ giúp bạn hiểu những gì đang ở trước mắt.</p>
      </div>
      {usesCloudflareTunnel && <div className="tunnel-notice" role="note"><Info size={19} /><p><strong>Đang kết nối qua Cloudflare Tunnel.</strong> Thông tin hồ sơ và ảnh bạn gửi sẽ đi qua Cloudflare trên đường tới máy tính này.</p></div>}
      <form className="auth-form" onSubmit={submit}>
        {registering && <label className="field-label">Tên bạn muốn được gọi<input required autoComplete="name" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ví dụ: Minh Anh" /></label>}
        {registering && capabilities?.registration_code_required && <label className="field-label">Mã mở hồ sơ<input required autoComplete="off" maxLength={80} value={registrationCode} onChange={(e) => setRegistrationCode(e.target.value)} placeholder="Nhập mã do chủ app cung cấp" /></label>}
        <label className="field-label">Tên đăng nhập<input required autoComplete={registering ? 'username' : 'username'} minLength={3} maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Ít nhất 3 ký tự" /></label>
        <label className="field-label">Mật khẩu
          <span className="password-wrap"><LockKey size={19} aria-hidden="true" /><input required autoComplete={registering ? 'new-password' : 'current-password'} type={showPassword ? 'text' : 'password'} minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Từ 8 ký tự" /><button type="button" className="icon-button" aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeSlash size={20} /> : <Eye size={20} />}</button></span>
        </label>
        {error && <p className="form-error" role="alert"><WarningCircle size={18} />{error}</p>}
        <ActionButton type="submit" className="auth-submit" icon={busy ? SpinnerGap : ArrowRight} disabled={busy}>{busy ? 'Đang mở hồ sơ…' : registering ? 'Tạo hồ sơ của tôi' : 'Đăng nhập'}</ActionButton>
      </form>
      <p className="auth-switch">{registering ? 'Đã có hồ sơ trên thiết bị này?' : 'Bạn chưa có hồ sơ?'} <button type="button" onClick={() => setMode(registering ? 'login' : 'register')}>{registering ? 'Đăng nhập' : 'Tạo hồ sơ'}</button></p>
      <p className="local-note"><LockKey size={15} /> Hồ sơ được lưu riêng trên máy chủ bạn đang dùng.</p>
    </section>
  )
}

function HomeScreen({ user, capabilities, operationEnabled, deviceConnection, onLive, onVoice, onProfile, onDevice }) {
  const [pathHealth, setPathHealth] = useState(null)
  const [pathHealthError, setPathHealthError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api('/api/segmentation/health', { signal: controller.signal, timeoutMs: 3500 })
      .then((health) => {
        setPathHealth(health)
        setPathHealthError('')
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          setPathHealth({ available: false, model_ready: false })
          setPathHealthError('Chưa kết nối được máy chủ phân tích lối đi.')
        }
      })
    return () => controller.abort()
  }, [])
  const hour = new Date().getHours()
  const greeting = hour < 11 ? 'Chào buổi sáng' : hour < 17 ? 'Chào buổi chiều' : 'Chào buổi tối'
  const { ready: voiceReady } = getVoiceReadiness(capabilities)
  const sharedRuntime = assistantProfile.shared_runtime
  const sharedAssistantUrl = capabilities?.shared_assistant_url || sharedRuntime.web_app_url
  const sharedAssistantModel = capabilities?.shared_assistant_model || assistantProfile.models[sharedRuntime.canonical_llm_model_key]
  const showSharedAssistantLink = Boolean(sharedAssistantUrl) && capabilities?.vision_provider !== 'cloudflare'
  const cloudTofOnly = deviceConnection?.transport === 'cloud_uplink'
  const localFirmwareCamera = deviceConnection?.transport === 'firmware_wifi'
  const pathServiceReady = pathHealth?.available === true && pathHealth?.model_ready === true
  const deviceActionLabel = cloudTofOnly ? 'ESP32 · trạng thái ToF' : localFirmwareCamera ? 'Camera ESP32 + ToF' : 'Kết nối ESP32'
  const chatAction = showSharedAssistantLink
    ? <a className="action-button action-button--dark home-feature-button" href={sharedAssistantUrl} aria-label="Mở cuộc trò chuyện AI dùng chung trên laptop và iPhone"><Microphone size={20} weight="bold" aria-hidden="true" /><span>Trò chuyện AI</span><ArrowRight size={18} weight="bold" aria-hidden="true" /></a>
    : <ActionButton icon={Microphone} tone="dark" className="home-feature-button" disabled={!voiceReady} onClick={onVoice}>{voiceReady ? 'Trò chuyện AI' : 'Thoại chưa sẵn sàng'}</ActionButton>
  return (
    <div className="home-screen page-pad">
      <header className="topbar">
        <Brand />
        <button className="profile-peek" onClick={onProfile} aria-label={`Mở hồ sơ của ${user.display_name}`}><span>{(user.display_name || 'R').slice(0, 1).toLocaleUpperCase('vi')}</span></button>
      </header>
      <section className="welcome-copy">
        <p className="eyebrow">{greeting.toLocaleUpperCase('vi')}</p>
        <h1>{user.display_name || 'Bạn'}<span className="welcome-comma">,</span><br />mình cùng xem nhé.</h1>
      </section>

      <section className="home-feature home-feature--detect" aria-labelledby="home-detect-title">
        <div className="home-feature-heading"><span className="home-feature-icon"><Eye size={22} weight="duotone" /></span><div><p className="eyebrow">01 · CAMERA TRỰC TIẾP</p><h2 id="home-detect-title">Tìm lối đi phía trước</h2></div></div>
        <p className="home-feature-copy">Mở camera điện thoại để xem gợi ý lối đi ở ba vùng: trái, giữa và phải. Ảnh được phân tích trên máy chủ của bạn; hướng dẫn hiện vẫn ở mức thử nghiệm.</p>
        <div className="home-feature-actions">
          <ActionButton icon={Eye} tone="mint" className="home-feature-button" onClick={onLive}>Mở chỉ dẫn lối đi</ActionButton>
          <button className="home-device-link" onClick={onDevice}><Cpu size={19} weight="duotone" /><span>{deviceActionLabel}</span><span className="home-device-state">{operationEnabled === true ? 'đang bật' : operationEnabled === false ? 'tạm dừng' : 'mở'}</span><ArrowRight size={18} /></button>
        </div>
        {cloudTofOnly && <p className="home-feature-limitation">Cloud hiện chỉ nhận telemetry ToF; camera và detection ESP32 chưa được relay. Dùng camera iPhone để chạy nhận diện qua YOLO host.</p>}
        <div className="home-feature-status" role="status" aria-live="polite"><span className={`status-dot${pathServiceReady ? ' status-dot--ready' : ''}`} /><span>{pathHealth === null ? 'Đang kiểm tra dịch vụ chỉ dẫn…' : pathServiceReady ? 'Dịch vụ chỉ dẫn lối đi đã sẵn sàng' : 'Dịch vụ chỉ dẫn chưa sẵn sàng'}</span><span className="home-feature-status-note">{pathHealthError || (pathServiceReady ? `Đang chạy trên ${pathHealth.device || 'máy chủ'}; hướng dẫn hiện vẫn ở mức thử nghiệm.` : 'Mở chỉ dẫn để xem trạng thái kết nối và thử lại.')}</span></div>
      </section>

      <section className="home-feature home-feature--chat" aria-labelledby="home-chat-title">
        <div className="home-feature-heading"><span className="home-feature-icon"><Microphone size={22} weight="duotone" /></span><div><p className="eyebrow">02 · HỎI ĐÁP BẰNG GIỌNG NÓI</p><h2 id="home-chat-title">Trò chuyện AI</h2></div></div>
        <p className="home-feature-copy">Nói câu hỏi bằng giọng nói; app sẽ tiếp tục nghe sau mỗi câu trả lời. STT, {sharedAssistantModel || 'mô hình trợ lý đã chọn'} và giọng đọc được xử lý qua dịch vụ đã cấu hình.</p>
        <div className="home-feature-actions">{chatAction}</div>
        {showSharedAssistantLink && <p className="voice-home-note">Dùng chung {sharedAssistantModel} và lịch sử khi đăng nhập cùng hồ sơ.</p>}
        {!voiceReady && !showSharedAssistantLink && <p className="voice-home-note">Dịch vụ thoại chưa sẵn sàng; kiểm tra kết nối rồi thử lại.</p>}
      </section>

      <div className="home-tip"><Info size={18} weight="duotone" /><p><strong>Kết quả phụ thuộc nguồn cảm biến.</strong> Camera iPhone không tự cung cấp khoảng cách; ToF chỉ có trong luồng ESP32 và chưa được gán cho từng vật thể.</p></div>
      <p className="home-footer">Một nhịp chậm. Một câu trả lời rõ.</p>
    </div>
  )
}

function DeviceScreen({ capabilities, connection, error, updatedAt, operationEnabled, pendingButtonAction, onPendingButtonActionHandled, capturedDeviceFrame, onCaptureDeviceFrame, accountSessionOwner, accountSessionToken, autoSpeak, onSpeak, onBack }) {
  const deviceSessionOwnerRef = useRef(null)
  if (deviceSessionOwnerRef.current === null) deviceSessionOwnerRef.current = createSessionOwner()
  const isCurrentDeviceWork = (deviceToken, accountToken = accountSessionToken) => (
    deviceSessionOwnerRef.current.owns(deviceToken) && accountSessionOwner.owns(accountToken)
  )
  const questionInputRef = useRef(null)
  const lastButtonActionRef = useRef(null)
  const askingRef = useRef(false)
  const deviceRecorderRef = useRef(null)
  const deviceRecorderStreamRef = useRef(null)
  const deviceMicRequestRef = useRef(false)
  const deviceSpeechRecognitionRef = useRef(null)
  const deviceRecorderTimerRef = useRef(0)
  const deviceRecorderStopHandlerRef = useRef(null)
  const deviceAutoAskRef = useRef(false)
  const [frameFailed, setFrameFailed] = useState(false)
  const [previewFrame, setPreviewFrame] = useState(null)
  const previewFrameUrlRef = useRef(null)
  const [captureError, setCaptureError] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState(null)
  const [askError, setAskError] = useState('')
  const [asking, setAsking] = useState(false)
  const [deviceRecording, setDeviceRecording] = useState(false)
  const [deviceTranscribing, setDeviceTranscribing] = useState(false)
  const [requestedDeviceVolume, setRequestedDeviceVolume] = useState(50)
  const [deviceControlBusy, setDeviceControlBusy] = useState(false)
  const [deviceControlMessage, setDeviceControlMessage] = useState('')
  const [deviceControlError, setDeviceControlError] = useState('')
  const [cloudClaim, setCloudClaim] = useState(null)
  const [cloudPairingBusy, setCloudPairingBusy] = useState(false)
  const [cloudPairingMessage, setCloudPairingMessage] = useState('')
  const [cloudPairingError, setCloudPairingError] = useState('')
  const [freshnessNow, setFreshnessNow] = useState(() => performance.now())

  useEffect(() => {
    const timer = window.setInterval(() => setFreshnessNow(performance.now()), 100)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => { setFrameFailed(false) }, [updatedAt])
  useEffect(() => () => {
    if (previewFrameUrlRef.current) URL.revokeObjectURL(previewFrameUrlRef.current)
  }, [])

  const status = connection?.status
  const linked = Boolean(connection?.device_connected)
  const currentOperationEnabled = operationEnabled ?? readOperationEnabled(status)
  const operationReady = currentOperationEnabled === true
  const operationPaused = currentOperationEnabled === false
  const frameSeq = Number.isInteger(status?.camera_frame) ? status.camera_frame : null
  const detections = Array.isArray(status?.detections) ? status.detections : []
  const zones = Array.isArray(status?.zones) ? status.zones : []
  const deviceLabel = connection?.transport === 'cloud_uplink'
    ? linked ? cloudDeviceStateLabel('device_connected') : cloudDeviceStateLabel(connection?.state)
    : linked ? (connection?.transport === 'firmware_wifi' ? 'ESP32 đang kết nối qua Wi-Fi firmware' : 'ESP32 đang kết nối qua bridge USB')
      : connection?.state === 'device_stale' ? 'Đã thấy ESP32 nhưng dữ liệu đã cũ'
        : connection?.available ? 'Bridge đã mở · chưa nhận ESP32' : 'Chưa kết nối ESP32'
  const statusElapsedMs = Number.isFinite(updatedAt)
    ? Math.max(0, freshnessNow - updatedAt)
    : Number.POSITIVE_INFINITY
  const reportedCameraAge = status?.camera_age_ms
  const cameraAge = typeof reportedCameraAge === 'number' && Number.isFinite(reportedCameraAge)
    ? reportedCameraAge + statusElapsedMs
    : null
  const frameFetchReady = operationReady && linked && status?.source === 'device'
    && status?.camera_input_state === 'live'
    && typeof reportedCameraAge === 'number' && Number.isFinite(reportedCameraAge)
    && reportedCameraAge >= 0 && reportedCameraAge <= CAMERA_FRAME_TTL_MS
    && Number.isInteger(frameSeq) && frameSeq > 0
  const cameraReady = frameFetchReady && typeof cameraAge === 'number'
    && Number.isFinite(cameraAge) && cameraAge >= 0 && cameraAge <= CAMERA_FRAME_TTL_MS
  const currentDeviceId = status?.device_health?.device_id || status?.device_id || null
  const currentBootId = status?.device_health?.boot_id || status?.boot_id || null
  const firmwareControlReady = connection?.transport === 'firmware_wifi'
    && linked && status?.source === 'device' && statusElapsedMs <= 2000
  const firmwareControlUnavailableMessage = connection?.transport !== 'firmware_wifi'
    ? 'Kết nối firmware Wi-Fi trực tiếp để mở điều khiển; USB bridge chỉ đọc.'
    : !linked || status?.source !== 'device'
      ? 'Chưa nhận được trạng thái kết nối ESP32 Wi-Fi mới.'
      : statusElapsedMs > 2000
        ? 'Đang chờ trạng thái ESP32 mới trước khi mở điều khiển.'
        : 'Điều khiển chưa sẵn sàng.'
  const previewSameSession = Boolean(previewFrame)
    && (!previewFrame.deviceId || !currentDeviceId || previewFrame.deviceId === currentDeviceId)
    && (!previewFrame.bootId || !currentBootId || previewFrame.bootId === currentBootId)
  const previewSequenceMatches = Boolean(previewFrame && Number.isInteger(frameSeq))
    && (connection?.transport === 'firmware_wifi'
      ? previewFrame.frameSeq >= frameSeq
      : previewFrame.frameSeq === frameSeq)
  const previewVisible = Boolean(previewFrame) && previewSameSession && operationReady
    && linked && status?.source === 'device' && status?.camera_input_state === 'live'
  const previewReady = cameraReady && previewVisible && previewSequenceMatches && !frameFailed
  const reportedTofAge = status?.tof_age_ms
  const tofAge = typeof reportedTofAge === 'number' && Number.isFinite(reportedTofAge)
    ? reportedTofAge + statusElapsedMs
    : null
  const cloudTofTransport = connection?.transport === 'cloud_uplink'
  const freshCloudEvent = cloudTofTransport && isFreshCloudDeviceEvent(connection?.latest_event, connection?.latest_event_age_ms)

  async function createCloudPairClaim() {
    setCloudPairingBusy(true)
    setCloudPairingMessage('')
    setCloudPairingError('')
    try {
      const payload = await api('/api/device/pair', { ...json({}), method: 'POST' })
      setCloudClaim({ code: payload.claim_code, expiresAt: payload.expires_at_ms })
      setCloudPairingMessage('Mã ghép chỉ hiện trong phiên này. Gửi lệnh bên dưới qua USB trước khi hết hạn.')
    } catch (pairError) {
      setCloudPairingError(pairError.message || 'Chưa tạo được mã ghép ESP32.')
    } finally { setCloudPairingBusy(false) }
  }

  async function copyCloudPairCommand() {
    try {
      await navigator.clipboard.writeText(formatDeviceClaimCommand(cloudClaim?.code))
      setCloudPairingMessage('Đã sao chép lệnh ghép USB.')
      setCloudPairingError('')
    } catch {
      setCloudPairingError('Không sao chép được. Hãy chọn và sao chép lệnh đang hiển thị.')
    }
  }

  async function unpairCloudDevice() {
    setCloudPairingBusy(true)
    setCloudPairingMessage('')
    setCloudPairingError('')
    try {
      await api('/api/device/unpair', { ...json({}), method: 'POST' })
      setCloudClaim(null)
      setCloudPairingMessage('Đã hủy ghép và thu hồi token thiết bị.')
    } catch (pairError) {
      setCloudPairingError(pairError.message || 'Chưa hủy ghép được thiết bị.')
    } finally { setCloudPairingBusy(false) }
  }
  const tofAgeLimitMs = cloudTofTransport ? CLOUD_DEVICE_CONTEXT_TTL_MS : DEVICE_CONTEXT_TTL_MS
  const healthBootId = status?.device_health?.boot_id || status?.boot_id
  const tofReadingPresent = zones.some((zone) => zone?.tof_valid === true
    && typeof zone.nearest_cm === 'number' && Number.isFinite(zone.nearest_cm)
    && zone.nearest_cm > 0 && zone.nearest_cm <= 100000)
  const tofAgeFresh = typeof tofAge === 'number' && Number.isFinite(tofAge)
    && tofAge >= 0 && tofAge <= tofAgeLimitMs
  const tofBootMatches = typeof status?.tof_boot_id === 'string' && status.tof_boot_id === healthBootId
  const tofAvailable = ['firmware_wifi', 'cloud_uplink'].includes(connection?.transport)
    && status?.source === 'device' && status?.tof_mode === 'device' && status?.tof_ok === true
    && tofAgeFresh && tofBootMatches && tofReadingPresent
  const tofStatusMessage = tofAvailable
    ? cloudTofTransport
      ? 'Số đo ToF của ESP32 được chuyển qua cloud và có thể trễ gần 2 giây. Đây là luồng độc lập với camera/detection; cảnh báo tức thời vẫn do ESP32 xử lý cục bộ.'
      : 'Khoảng cách do firmware báo; chưa phải chỉ dẫn lối đi an toàn.'
    : cloudTofTransport
      ? status?.tof_ok !== true
        ? 'Chưa nhận được số đo ToF mới qua cloud; app giữ trạng thái unknown.'
        : !tofBootMatches
          ? 'Số đo ToF thuộc phiên khởi động khác; app giữ trạng thái unknown.'
          : !tofAgeFresh
            ? 'Telemetry ToF qua cloud đã cũ; app giữ trạng thái unknown.'
            : !tofReadingPresent
              ? 'Chưa có vùng ToF hợp lệ trong telemetry; app giữ trạng thái unknown.'
              : 'Số đo ToF chưa được xác nhận; app giữ trạng thái unknown.'
      : connection?.transport !== 'firmware_wifi'
      ? 'Bridge probe hiện báo ToF unknown; không hiển thị giá trị mô phỏng như số đo thiết bị.'
      : status?.tof_ok !== true
        ? 'Firmware hiện báo ToF chưa sẵn sàng; không có số đo thiết bị để hiển thị.'
        : !tofBootMatches
          ? 'Số đo ToF thuộc phiên khởi động khác; app giữ trạng thái unknown.'
          : !tofAgeFresh
            ? 'Số đo ToF đã cũ hơn 350 ms; app giữ trạng thái unknown.'
            : !tofReadingPresent || status?.tof_mode !== 'device'
              ? 'Chưa có số đo ToF nguồn device hợp lệ; app giữ trạng thái unknown.'
              : 'Số đo ToF chưa được xác nhận; app giữ trạng thái unknown.'
  const detectionFrameSeq = Number.isInteger(status?.detections_frame_seq)
    ? status.detections_frame_seq
    : Number.isInteger(status?.camera_frame_info?.detections_frame_seq)
      ? status.camera_frame_info.detections_frame_seq
      : null
  const reportedDetectionAge = connection?.transport === 'firmware_wifi'
    ? status?.detections_age_ms
    : status?.device_link?.inference_age_ms
  const detectionAge = typeof reportedDetectionAge === 'number' && Number.isFinite(reportedDetectionAge)
    ? reportedDetectionAge + statusElapsedMs
    : null
  const detectionsFresh = isDeviceDetectionAgeFresh(detectionAge)
    && (connection?.transport !== 'firmware_wifi'
      || typeof status?.detections_boot_id === 'string' && status.detections_boot_id === healthBootId)
  const firmwareDetectorReported = connection?.transport === 'firmware_wifi'
    && status?.source === 'device'
    && typeof status?.detector_model === 'string'
    && ['fomo:', 'espdet:'].some((prefix) => status.detector_model.toLowerCase().startsWith(prefix))
    && status?.inference_status === 'ok'
  const firmwareDetectorIdReported = connection?.transport === 'firmware_wifi'
    && typeof status?.detector_model === 'string'
    && ['fomo:', 'espdet:'].some((prefix) => status.detector_model.toLowerCase().startsWith(prefix))
  const detectionsMatchFrame = Boolean(firmwareDetectorReported && previewReady && detectionsFresh
    && deviceDetectionMatchesFrame(detectionFrameSeq, previewFrame.frameSeq))
  const visibleDetections = detectionsMatchFrame ? detections : []
  const firmwareDetectorStatusMessage = connection?.transport !== 'firmware_wifi'
    ? 'Đang chờ model ESP32 và output mới từ firmware qua Wi-Fi; BLE/USB chưa cung cấp output model đã xác nhận.'
    : !firmwareDetectorIdReported
      ? `Firmware chưa báo model ESP32 được hỗ trợ; hiện báo ${status?.detector_model || 'chưa có model'}.`
      : status?.inference_status !== 'ok'
        ? 'Firmware đã báo model nhưng inference chưa thành công; app chưa hiển thị kết quả.'
        : !firmwareDetectorReported
          ? 'Firmware chưa xác nhận trạng thái detector; app đang ẩn kết quả.'
        : detectionsMatchFrame
          ? ''
          : 'Chưa có output detector mới cùng boot và frame JPEG đang hiển thị; dữ liệu cũ hoặc không khớp bị ẩn.'
  const audioAvailable = typeof status?.audio_ok === 'boolean'
  const visionLabel = capabilities?.vision_provider === 'ollama' ? 'Qwen3-VL trên máy tính' : capabilities?.vision_provider === 'openai' ? 'Vision qua OpenAI API' : 'Vision chưa sẵn sàng'
  const canAsk = operationReady && (cloudTofTransport || (previewReady && Boolean(capabilities?.vision_ready)))
  const askStateLabel = operationPaused ? 'THIẾT BỊ TẠM DỪNG' : !operationReady ? 'CHỜ TRẠNG THÁI THIẾT BỊ' : cloudTofTransport ? 'HỎI ĐÁP VĂN BẢN QUA CLOUD' : !capabilities?.vision_ready ? 'VISION CHƯA SẴN SÀNG' : previewReady ? 'CHỈ GỬI KHI CÓ YÊU CẦU' : 'ĐANG CHỜ DỮ LIỆU'

  const sendDeviceControl = async (commandPayload) => {
    if (!firmwareControlReady || deviceControlBusy) return
    setDeviceControlBusy(true)
    setDeviceControlError('')
    setDeviceControlMessage('')
    try {
      const result = await api('/api/device/command', json(commandPayload))
      if (result?.ack?.type !== 'command_ack'
          || result.ack.ok !== true || result.ack.command !== commandPayload.command) {
        throw new Error('Firmware chưa xác nhận đúng lệnh điều khiển.')
      }
      const requested = commandPayload.command === 'set_volume'
        ? `mức âm lượng ${commandPayload.value}%`
        : `cài đặt ${commandPayload.enabled ? 'bật' : 'tắt'} cảnh báo`
      const standbyNote = result.operation_enabled === false
        ? ' Thiết bị vẫn tạm dừng; lệnh này không bật MODE.'
        : ''
      setDeviceControlMessage(`Firmware đã ACK ${requested}.${standbyNote} ACK không xác nhận loa hay cảnh báo hoạt động.`)
    } catch (err) {
      setDeviceControlError(err.message || 'Chưa gửi được lệnh điều khiển tới ESP32.')
    } finally {
      setDeviceControlBusy(false)
    }
  }

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setFrameFailed(false)
    if (!frameFetchReady || frameSeq === null) {
      if (!linked || !operationReady || status?.source !== 'device' || status?.camera_input_state !== 'live') {
        if (previewFrameUrlRef.current) URL.revokeObjectURL(previewFrameUrlRef.current)
        previewFrameUrlRef.current = null
        setPreviewFrame(null)
      }
      return () => { alive = false; controller.abort() }
    }

    const loadFrame = async () => {
      try {
        const query = new URLSearchParams({ frame_seq: String(frameSeq), t: String(updatedAt || Date.now()) })
        const response = await fetchApp(`/api/device/frame?${query}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        })
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload?.error || 'Không lấy được JPEG mới từ ESP32.')
        }
        const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].toLowerCase()
        const receivedSeq = Number(response.headers.get('X-Frame-Seq'))
        const blob = await response.blob()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const sequenceMatchesStatus = connection?.transport === 'firmware_wifi'
          ? receivedSeq >= frameSeq
          : receivedSeq === frameSeq
        if (contentType !== 'image/jpeg' || !Number.isInteger(receivedSeq) || receivedSeq < 1
            || !sequenceMatchesStatus
            || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
            || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
          throw new Error('Ảnh JPEG không khớp frame mới nhất của ESP32.')
        }
        const url = URL.createObjectURL(blob)
        if (!alive) {
          URL.revokeObjectURL(url)
          return
        }
        if (previewFrameUrlRef.current) URL.revokeObjectURL(previewFrameUrlRef.current)
        previewFrameUrlRef.current = url
        setPreviewFrame({
          url,
          blob,
          frameSeq: receivedSeq,
          deviceId: currentDeviceId,
          bootId: currentBootId,
        })
      } catch (err) {
        if (alive && err.name !== 'AbortError') setFrameFailed(true)
      }
    }
    void loadFrame()
    return () => { alive = false; controller.abort() }
  }, [frameFetchReady, frameSeq, updatedAt, connection?.transport, currentDeviceId, currentBootId, linked, operationReady, status?.source, status?.camera_input_state])

  const askWithPrompt = async (prompt, trigger = 'manual') => {
    const deviceToken = deviceSessionOwnerRef.current.current()
    const accountToken = accountSessionToken
    const isCurrent = () => isCurrentDeviceWork(deviceToken, accountToken)
    if (!isCurrent()) return
    if (askingRef.current) return
    if (!operationReady) {
      setAskError(operationPaused ? deviceOperationPauseMessage(status) : 'Chưa xác nhận trạng thái hoạt động của ESP32.')
      return
    }
    if (!cloudTofTransport && !cameraReady) {
      setAskError('ESP32 chưa có khung hình mới trong giới hạn 1 giây. Chờ frame cập nhật rồi thử lại.')
      return
    }
    if (!cloudTofTransport && !capabilities?.vision_ready) {
      setAskError('Vision chưa sẵn sàng trên máy chủ; câu hỏi chưa được gửi.')
      return
    }
    askingRef.current = true
    setAsking(true)
    setAskError('')
    try {
      const payload = await api('/api/device/ask', { ...json({ question: prompt, trigger }), timeoutMs: 200000 })
      if (!isCurrent()) return
      setAnswer(payload)
      if (autoSpeak) onSpeak(payload.answer)
    } catch (err) {
      if (isCurrent()) setAskError(err.message || 'Chưa trả lời được câu hỏi này.')
    } finally {
      askingRef.current = false
      if (isCurrent()) setAsking(false)
    }
  }

  const stopDeviceRecording = () => {
    const recognition = deviceSpeechRecognitionRef.current
    if (recognition) {
      try { recognition.stop() } catch {}
      return
    }
    const recorder = deviceRecorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
  }

  const startDeviceRecording = async (autoAsk = false) => {
    const deviceToken = deviceSessionOwnerRef.current.current()
    const accountToken = accountSessionToken
    const isCurrent = () => isCurrentDeviceWork(deviceToken, accountToken)
    if (!isCurrent()) return
    if (deviceSpeechRecognitionRef.current) {
      if (autoAsk) deviceAutoAskRef.current = true
      if (autoAsk) stopDeviceRecording()
      return
    }
    if (deviceRecorderRef.current?.state === 'recording') {
      if (autoAsk) deviceAutoAskRef.current = true
      if (autoAsk) stopDeviceRecording()
      return
    }
    if (deviceMicRequestRef.current) {
      if (autoAsk) deviceAutoAskRef.current = true
      return
    }
    if (askingRef.current) return
    if (autoAsk && !cloudTofTransport && !cameraReady) {
      setAskError('Chưa có khung hình ESP32 mới. Đợi camera cập nhật rồi nhấn nút hỏi lại.')
      return
    }
    if (autoAsk && !cloudTofTransport && !capabilities?.vision_ready) {
      setAskError('Vision chưa sẵn sàng trên máy chủ; câu hỏi chưa được ghi hoặc gửi.')
      return
    }

    setAskError('')
    deviceAutoAskRef.current = autoAsk

    const SpeechRecognition = speechRecognitionConstructor()
    if (shouldUseDeviceBrowserSpeechRecognition(connection?.transport, SpeechRecognition)) {
      let transcriptText = ''
      let recognitionError = ''
      let recognition
      try {
        recognition = new SpeechRecognition()
        recognition.lang = 'vi-VN'
        recognition.continuous = false
        recognition.interimResults = true
        recognition.onresult = (event) => {
          if (!isCurrent()) return
          transcriptText = Array.from(event.results || [])
            .map((result) => result?.[0]?.transcript || '')
            .filter(Boolean)
            .join(' ')
            .trim()
          if (transcriptText) setQuestion(transcriptText)
        }
        recognition.onerror = (event) => { recognitionError = event?.error || '' }
        recognition.onend = async () => {
          if (!isCurrent()) return
          if (deviceSpeechRecognitionRef.current !== recognition) return
          window.clearTimeout(deviceRecorderTimerRef.current)
          deviceRecorderTimerRef.current = 0
          deviceSpeechRecognitionRef.current = null
          setDeviceRecording(false)
          const prompt = transcriptText.trim()
          if (!prompt) {
            setAskError(speechRecognitionErrorMessage(recognitionError))
            deviceAutoAskRef.current = false
            return
          }
          setQuestion(prompt)
          setAskError('')
          if (deviceAutoAskRef.current) {
            deviceAutoAskRef.current = false
            await askWithPrompt(prompt, 'button_event')
          } else {
            deviceAutoAskRef.current = false
          }
        }
        deviceSpeechRecognitionRef.current = recognition
        recognition.start()
        setDeviceRecording(true)
        deviceRecorderTimerRef.current = window.setTimeout(() => {
          if (deviceSpeechRecognitionRef.current === recognition) {
            try { recognition.stop() } catch {}
          }
        }, 10000)
      } catch (err) {
        if (deviceSpeechRecognitionRef.current === recognition) deviceSpeechRecognitionRef.current = null
        deviceAutoAskRef.current = false
        if (isCurrent()) {
          setDeviceRecording(false)
          setAskError(err?.error
            ? speechRecognitionErrorMessage(err.error)
            : err.message || 'Safari chưa mở được nhận dạng giọng nói. Dùng mic Dictation trên bàn phím iPhone.')
        }
      }
      return
    }

    if (!capabilities?.transcription_ready) {
      deviceAutoAskRef.current = false
      setAskError('Safari chưa có Speech Recognition và máy chủ chưa bật API phiên âm. Chạm vào ô câu hỏi rồi dùng mic Dictation trên bàn phím iPhone.')
      questionInputRef.current?.focus()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      deviceAutoAskRef.current = false
      setAskError('Trình duyệt chưa hỗ trợ ghi âm trong app. Hãy chạm vào ô câu hỏi rồi dùng mic Dictation trên bàn phím iPhone.')
      questionInputRef.current?.focus()
      return
    }

    try {
      deviceMicRequestRef.current = true
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (stopMediaStreamIfStale(stream, isCurrent)) return
      deviceRecorderStreamRef.current = stream
      const mimeTypes = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? mimeTypes.find((type) => MediaRecorder.isTypeSupported(type))
        : null
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      const chunks = []
      deviceRecorderRef.current = recorder
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size) chunks.push(event.data)
      })
      const handleRecorderStop = async () => {
        window.clearTimeout(deviceRecorderTimerRef.current)
        deviceRecorderTimerRef.current = 0
        stream.getTracks().forEach((track) => track.stop())
        deviceRecorderStreamRef.current = null
        deviceRecorderRef.current = null
        deviceRecorderStopHandlerRef.current = null
        if (!isCurrent()) return
        setDeviceRecording(false)
        if (!chunks.length) {
          setAskError('Không thu được câu nói. Nhấn nút mic rồi nói lại nhé.')
          deviceAutoAskRef.current = false
          return
        }

        setDeviceTranscribing(true)
        setAskError('')
        try {
          const extension = recorder.mimeType.includes('mp4') ? 'm4a' : 'webm'
          const body = new FormData()
          body.append('audio', new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), `device-question.${extension}`)
          const transcript = await api('/api/transcribe', { method: 'POST', body, timeoutMs: 45000 })
          if (!isCurrent()) return
          const prompt = String(transcript?.text || '').trim()
          if (!prompt) throw new Error('Chưa nghe rõ câu hỏi. Nhấn nút mic rồi nói lại nhé.')
          setQuestion(prompt)
          setAskError('')
          if (deviceAutoAskRef.current) {
            await askWithPrompt(prompt, 'button_event')
          }
        } catch (err) {
          if (isCurrent()) setAskError(err.message || 'Không chuyển được câu nói thành chữ.')
        } finally {
          deviceAutoAskRef.current = false
          if (isCurrent()) setDeviceTranscribing(false)
        }
      }
      deviceRecorderStopHandlerRef.current = handleRecorderStop
      recorder.addEventListener('stop', handleRecorderStop, { once: true })
      recorder.start()
      setDeviceRecording(true)
      deviceRecorderTimerRef.current = window.setTimeout(() => {
        if (deviceRecorderRef.current?.state === 'recording') deviceRecorderRef.current.stop()
      }, 10000)
    } catch (err) {
      deviceRecorderStreamRef.current?.getTracks().forEach((track) => { try { track.stop() } catch {} })
      deviceRecorderStreamRef.current = null
      deviceRecorderRef.current = null
      if (isCurrent()) setAskError(microphoneErrorMessage(err))
    } finally {
      deviceMicRequestRef.current = false
    }
  }

  useEffect(() => () => {
    deviceSessionOwnerRef.current.advance()
    window.clearTimeout(deviceRecorderTimerRef.current)
    const recognition = deviceSpeechRecognitionRef.current
    if (recognition) {
      deviceSpeechRecognitionRef.current = null
      recognition.onend = null
      recognition.onerror = null
      try { recognition.stop() } catch {}
    }
    const recorder = deviceRecorderRef.current
    if (recorder && deviceRecorderStopHandlerRef.current) {
      recorder.removeEventListener('stop', deviceRecorderStopHandlerRef.current)
    }
    deviceRecorderStopHandlerRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch {}
    }
    deviceRecorderRef.current = null
    deviceRecorderStreamRef.current?.getTracks().forEach((track) => { try { track.stop() } catch {} })
    deviceRecorderStreamRef.current = null
  }, [])

  const askAboutFrame = (event) => {
    event.preventDefault()
    const prompt = question.trim()
    if (!prompt || !canAsk || askingRef.current) return
    void askWithPrompt(prompt)
  }

  useEffect(() => {
    const pending = pendingButtonAction
    const eventKey = pending?.key
    if (!eventKey || asking || lastButtonActionRef.current === eventKey) return
    lastButtonActionRef.current = eventKey

    const pendingAgeMs = Number.isFinite(pending.eventAgeMs) ? pending.eventAgeMs : 0
    const pendingElapsedMs = Number.isFinite(pending.receivedAt)
      ? Math.max(0, performance.now() - pending.receivedAt)
      : 0
    if (pendingAgeMs + pendingElapsedMs > 10000) {
      const message = 'Nút đã hết hạn; app chưa chụp ảnh hoặc gửi câu hỏi.'
      if (pending.action === 'capture_image') setCaptureError(message)
      else if (pending.action === 'ask_llm') setAskError(message)
      onPendingButtonActionHandled(eventKey)
      return
    }

    if (!operationReady) {
      const message = operationPaused ? deviceOperationPauseMessage(status) : 'Chưa xác nhận trạng thái hoạt động của ESP32.'
      if (pending.action === 'capture_image') setCaptureError(message)
      else if (pending.action === 'ask_llm') setAskError(message)
      onPendingButtonActionHandled(eventKey)
      return
    }

    if (pending.action === 'capture_image') {
      if (!cameraReady) {
        setCaptureError('ESP32 chưa có khung hình mới trong giới hạn 1 giây. Chờ frame cập nhật rồi chụp lại.')
        onPendingButtonActionHandled(eventKey)
        return
      }
      const capture = async () => {
        const deviceToken = deviceSessionOwnerRef.current.current()
        const accountToken = accountSessionToken
        const isCurrent = () => isCurrentDeviceWork(deviceToken, accountToken)
        if (!isCurrent()) return
        setCaptureError('')
        try {
          const query = new URLSearchParams({ t: String(Date.now()) })
          if (Number.isInteger(pending.frameSeq)) query.set('frame_seq', String(pending.frameSeq))
          const response = await fetchApp(`/api/device/frame?${query}`, { credentials: 'same-origin', cache: 'no-store' })
          if (!isCurrent()) return
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            if (!isCurrent()) return
            throw new Error(payload?.error || 'Không lấy được JPEG mới từ ESP32.')
          }
          const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].toLowerCase()
          const blob = await response.blob()
          if (!isCurrent()) return
          const bytes = new Uint8Array(await blob.arrayBuffer())
          if (!isCurrent()) return
          if (contentType !== 'image/jpeg' || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
            throw new Error('Ảnh nhận được không phải JPEG hợp lệ.')
          }
          const responseSeq = Number(response.headers.get('X-Frame-Seq'))
          if (!Number.isInteger(responseSeq) || responseSeq < 1) throw new Error('JPEG thiếu số frame hợp lệ.')
          if (Number.isInteger(pending.frameSeq)) {
            const matchesStatus = connection?.transport === 'firmware_wifi'
              ? responseSeq >= pending.frameSeq
              : responseSeq === pending.frameSeq
            if (!matchesStatus) throw new Error('JPEG trả về không khớp frame ESP32 vừa báo.')
          }
          onCaptureDeviceFrame(blob, responseSeq, accountToken)
        } catch (err) {
          if (isCurrent()) setCaptureError(err.message || 'Không lưu được ảnh JPEG.')
        } finally {
          if (accountSessionOwner.owns(accountToken)) onPendingButtonActionHandled(eventKey)
        }
      }
      void capture()
      return
    }

    if (pending.action === 'ask_llm') {
      setQuestion('')
      setAskError('')
      void startDeviceRecording(true).finally(() => onPendingButtonActionHandled(eventKey))
    }
  }, [pendingButtonAction?.key, asking, autoSpeak, onSpeak, onCaptureDeviceFrame, onPendingButtonActionHandled, operationReady, operationPaused, cameraReady, connection?.transport, capabilities?.vision_ready, capabilities?.transcription_ready, status, accountSessionOwner, accountSessionToken])

  return (
    <div className="device-screen page-pad">
      <header className="subpage-top"><button className="back-button" onClick={onBack}><ArrowLeft size={21} />Về trang chính</button><span className={`live-state ${linked ? 'live-state--on' : ''}`}><span />{linked ? 'ĐÃ KẾT NỐI' : 'CHỜ THIẾT BỊ'}</span></header>
      <div className="live-heading"><p className="eyebrow">CẢM BIẾN ESP32</p><h1>Trạng thái<br /><em>thiết bị.</em></h1><p>{cloudTofTransport ? 'Cloud nhận ToF và kết quả phân đoạn khi chụp; nút hỏi đáp mở mic điện thoại và gửi câu hỏi văn bản lên trợ lý. Cloud không giữ ảnh gốc hoặc video trực tiếp.' : 'Theo dõi camera, detector và ToF của ESP32 khi firmware/bridge cục bộ cung cấp các luồng này.'}</p></div>

      <section className={`device-connection ${linked ? 'is-connected' : ''}`} aria-live="polite">
        {linked ? <WifiHigh size={23} /> : <WifiSlash size={23} />}
        <div><strong>{deviceLabel}</strong><span>{error || (connection?.transport === 'cloud_uplink' ? `Cloud uplink · telemetry ${Number.isFinite(status?.telemetry_age_ms) ? `${Math.round(status.telemetry_age_ms)} ms` : 'chưa có'}` : status?.device_link?.transport) || 'Đang kiểm tra kết nối…'}{connection?.transport === 'firmware_wifi' && status?.events_connected === false ? ' · Chưa nhận telemetry WebSocket' : ''}</span></div>
        <span className={`status-dot ${linked ? 'status-dot--ready' : ''}`} />
      </section>

      {cloudTofTransport && <section className="device-section device-cloud-pairing" aria-labelledby="device-cloud-pairing-title">
        <div className="section-title"><h2 id="device-cloud-pairing-title">Ghép ESP32 với cloud</h2><span>{connection?.state === 'unpaired' ? 'CHƯA GHÉP' : connection?.state === 'awaiting_first_telemetry' ? 'ĐÃ GHÉP' : connection?.state === 'device_stale' ? 'DỮ LIỆU CŨ' : 'ĐANG NỐI'}</span></div>
        <p className="device-unknown">Tạo mã ghép dùng một lần, còn hạn 10 phút. Mã thiết bị chỉ được lưu dạng hash ở cloud; app không nhận lại device token.</p>
        {cloudClaim && <div className="device-cloud-claim" role="status">
          <strong>Lệnh gửi qua USB trước {formatDeviceClaimExpiry(cloudClaim.expiresAt)}</strong>
          <code>{formatDeviceClaimCommand(cloudClaim.code)}</code>
          <button className="action-button" type="button" onClick={() => void copyCloudPairCommand()}>Sao chép lệnh</button>
        </div>}
        <div className="device-cloud-pair-actions">
          <button className="action-button action-button--dark" type="button" disabled={cloudPairingBusy} onClick={() => void createCloudPairClaim()}>{cloudPairingBusy ? 'Đang xử lý…' : cloudClaim ? 'Tạo mã mới' : 'Tạo mã ghép'}</button>
          {connection?.state !== 'unpaired' && <button className="action-button" type="button" disabled={cloudPairingBusy} onClick={() => void unpairCloudDevice()}>Hủy ghép thiết bị</button>}
        </div>
        {cloudPairingMessage && <p className="device-control-message" role="status">{cloudPairingMessage}</p>}
        {cloudPairingError && <p className="form-error" role="alert">{cloudPairingError}</p>}
      </section>}

      {freshCloudEvent && <section className="device-section device-cloud-event" aria-live="polite">
        <div className="section-title"><h2>Ảnh mới từ ESP32</h2><span>{Math.round(connection.latest_event_age_ms)} ms</span></div>
        <strong>{connection.latest_event.guidance?.label_vi || 'Đã phân đoạn ảnh'}</strong>
        <p className="device-unknown">Khung {connection.latest_event.frame_seq} · {connection.latest_event.model_id} · {Math.round(connection.latest_event.inference_ms)} ms · kết quả thử nghiệm</p>
        {!!connection.latest_event.classes_present?.length && <ul className="device-cloud-event-classes">{connection.latest_event.classes_present.slice(0, 8).map((item) => <li key={`${item.class_id}-${item.class_name}`}>{item.class_name}<span>{(item.area_ratio * 100).toFixed(1)}%</span></li>)}</ul>}
        <p className="device-unknown">ToF lúc chụp: {Number.isFinite(connection.latest_event.tof_center_cm) ? `${(connection.latest_event.tof_center_cm / 100).toFixed(2)} m` : 'chưa có số đo'}; ảnh đã xử lý tạm và không được lưu.</p>
      </section>}

      <section className="device-ask" aria-labelledby="device-ask-title">
        <div className="section-title"><h2 id="device-ask-title">Hỏi đáp AI</h2><span>{askStateLabel}</span></div>
        <p className="device-ask-copy">{cloudTofTransport
          ? 'Nút 3 hoặc mic trên trang sẽ ghi âm bằng điện thoại, gửi âm thanh lên STT máy chủ rồi chuyển câu chữ tới trợ lý. Không có ảnh gốc trong cloud; AI chỉ nhận tóm tắt cảm biến mới nếu còn hạn.'
          : 'Hỏi về khung hình mới của ESP32. Câu hỏi được phiên âm rồi gửi cùng ngữ cảnh ảnh khi dịch vụ Vision sẵn sàng.'}</p>
        <form onSubmit={askAboutFrame}>
          <div className="device-question-box">
            <textarea
              ref={questionInputRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={400}
              placeholder="Nói hoặc nhập câu hỏi…"
              rows={2}
              disabled={asking || deviceTranscribing}
              aria-label="Câu hỏi dành cho trợ lý AI"
            />
            <button
              className={`record-button ${deviceRecording ? 'is-recording' : ''}`}
              type="button"
              disabled={!operationReady || asking || deviceTranscribing}
              onClick={() => deviceRecording ? stopDeviceRecording() : void startDeviceRecording(false)}
              aria-label={deviceRecording ? 'Dừng ghi âm' : 'Ghi âm câu hỏi bằng mic điện thoại'}
              title={deviceRecording ? 'Dừng ghi âm' : 'Ghi âm câu hỏi'}
            >{deviceRecording ? <MicrophoneSlash size={21} /> : <Microphone size={21} />}</button>
          </div>
          <button className="analyze-button" type="submit" disabled={!canAsk || asking || deviceRecording || deviceTranscribing || !question.trim()}>
            {deviceTranscribing ? 'Đang phiên âm trên máy chủ…' : asking ? 'Đang hỏi trợ lý…' : 'Gửi câu hỏi'}
          </button>
        </form>
        {askError && <p className="form-error device-ask-error" role="alert">{askError}</p>}
        {answer?.answer && <article className="device-answer" aria-live="polite">
          <div><span className="eyebrow">RÕ TRẢ LỜI</span><p>{answer.answer}</p>
            {cloudTofTransport && <p className="device-ask-note">Trả lời dựa trên câu chữ và ngữ cảnh cảm biến còn mới; cloud không có ảnh gốc để xem.</p>}
          </div>
          <button className="device-answer-speak" type="button" onClick={() => onSpeak(answer.answer)} aria-label="Nghe câu trả lời"><SpeakerHigh size={18} />Nghe</button>
        </article>}
      </section>

      {!cloudTofTransport && <div className={`device-frame ${previewReady ? 'is-live' : ''}`}>
        {previewVisible ? <img key={previewFrame.frameSeq} src={previewFrame.url} alt={`Ảnh JPEG từ ESP32, số ${previewFrame.frameSeq}${previewReady ? ', còn mới' : ', đã cũ'}`} /> : (
          <div className="device-frame-empty"><Camera size={31} /><strong>{operationPaused ? 'Thiết bị đang tạm dừng' : !operationReady ? 'Đang chờ trạng thái hoạt động' : !linked ? 'Chưa có hình từ ESP32' : frameFailed ? 'Chưa lấy được JPEG mới' : 'Đang chờ khung hình camera mới'}</strong><span>{operationPaused ? deviceOperationPauseMessage(status) : !operationReady ? 'App chỉ mở thao tác khi firmware xác nhận operation_enabled=true.' : frameFailed ? 'Chưa có JPEG hợp lệ kèm số frame. App chưa hiển thị frame cũ.' : status?.camera_error || (error || 'Đang kiểm tra trạng thái camera và frame mới từ thiết bị.')}</span></div>
        )}
        {previewReady && detectionsMatchFrame && <svg className="device-detection-overlay" viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet" aria-hidden="true">{visibleDetections.slice(0, 10).map((item, index) => {
          const box = item.bbox
          if (!box || ![box.x_min, box.y_min, box.x_max, box.y_max].every(Number.isFinite)) return null
          const label = `${item.class_name || 'vật thể'} ${Math.round((item.confidence || 0) * 100)}%`
          const tagWidth = Math.max(0.14, Math.min(0.46, label.length * 0.014 + 0.035))
          const tagY = Math.max(0.008, box.y_min - 0.042)
          const tagX = Math.max(0.005, Math.min(box.x_min, 0.995 - tagWidth))
          return <g key={`${item.class_name}-${index}`}><rect className="detection-box" x={box.x_min} y={box.y_min} width={Math.max(0, box.x_max - box.x_min)} height={Math.max(0, box.y_max - box.y_min)} rx="0.012" /><rect className="detection-tag" x={tagX} y={tagY} width={tagWidth} height="0.038" rx="0.008" /><text className="detection-text" x={tagX + 0.012} y={tagY + 0.026} fontSize="0.024">{label}</text></g>
        })}</svg>}
        {previewVisible && <span className={`device-frame-badge${previewReady ? '' : ' device-frame-badge--stale'}`}>{previewReady ? `ESP32 · JPEG ${previewFrame.frameSeq}${detectionsMatchFrame ? ' · model khớp frame' : ''}` : `Ảnh ESP32 cũ · khung ${previewFrame.frameSeq} · thao tác đã khóa`}</span>}
      </div>}

      {error && <div className="device-help" role="status"><Info size={18} /><p>{error} Với firmware IDF, nối máy tính vào Wi-Fi ESP32 rồi đặt `RO_DEVICE_FIRMWARE_URL` theo địa chỉ firmware. Với probe USB cũ, chạy `start_device_bridge.ps1` trên máy tính.</p></div>}
      {connection?.available && !linked && <div className="device-help" role="note"><Info size={18} /><p>Bridge đang hoạt động nhưng nguồn hiện tại không phải ESP32. App chỉ báo kết nối thiết bị khi backend nhận `source=device` từ firmware bridge.</p></div>}

      <section className="device-section">
        <div className="section-title"><h2>Nhận diện cục bộ trên ESP32</h2><span>{detectionsMatchFrame ? 'FRAME MỚI' : 'ĐANG CHỜ'}</span></div>
        {detectionsMatchFrame && visibleDetections.length ? <ul className="object-list">{visibleDetections.slice(0, 8).map((item, index) => {
          const labels = { person: 'người', vehicle: 'phương tiện', obstacle: 'chướng ngại vật', stairs: 'cầu thang', traffic_signal: 'đèn giao thông', crossing_cue: 'tín hiệu qua đường', pole: 'cột', drop_off: 'chỗ hụt', blocking_hazard: 'vật cản' }
          return <li key={`${item.class_name}-${index}`}><span className="object-glyph"><Eye size={17} /></span><span className="object-name">{labels[item.class_name] || item.class_name || 'vật thể'}<small>{item.zone || 'trong khung hình'}</small></span><span className="object-confidence">{Math.round((item.confidence || 0) * 100)}%</span></li>
        })}</ul> : <p className="device-unknown">{cloudTofTransport ? 'Cloud chưa có luồng video liên tục; chỉ nhận kết quả ảnh sau nút chụp.' : detectionsMatchFrame ? 'Detector trên ESP32 đã xử lý JPEG này nhưng chưa báo vật thể.' : firmwareDetectorStatusMessage}</p>}
        {connection?.transport === 'firmware_wifi' && <p className="device-unknown">Model firmware: {status?.detector_model || 'chưa có model'} · inference: {status?.inference_status || 'chưa có kết quả mới'}.</p>}
      </section>

      <section className="device-section">
        <div className="section-title"><h2>ToF · trái / giữa / phải</h2><span>{tofAvailable ? (cloudTofTransport ? 'CLOUD' : 'LIVE') : 'CHƯA CÓ'}</span></div>
        <div className="device-zones">{['left', 'center', 'right'].map((zone) => {
          const measure = zones.find((item) => item.zone === zone)
          const label = zone === 'left' ? 'Trái' : zone === 'center' ? 'Giữa' : 'Phải'
          const distance = tofAvailable && Number.isFinite(measure?.nearest_cm) ? `${(measure.nearest_cm / 100).toFixed(1)} m` : 'Chưa có số đo'
          return <div key={zone}><span>{label}</span><strong>{distance}</strong></div>
        })}</div>
        <p className="device-unknown">{tofStatusMessage}</p>
      </section>

      <section className="device-section device-fusion">
        <div className="section-title"><h2>Hướng dẫn camera trên web</h2><span>SEGFORMER · SANPO</span></div>
        <p className="device-unknown">Kết quả điều hướng của firmware ESP32/Warning6 không được dùng trong app web. Để nhận gợi ý trái, giữa, phải, mở Camera trực tiếp; app sẽ gửi hình camera điện thoại tới SegFormer-B2 trên máy chủ laptop khi dịch vụ sẵn sàng.</p>
        <p className="device-unknown">Các số ToF phía trên chỉ là telemetry ESP32; hiện chưa ghép thời gian với từng frame camera điện thoại. App không suy ra khoảng cách theo mét từ mask segmentation.</p>
      </section>

      <section className="device-section device-controls">
        <div className="section-title"><h2>Điều khiển firmware</h2><span>{firmwareControlReady ? 'WI-FI' : 'CHƯA SẴN SÀNG'}</span></div>
        <p className="device-unknown">Firmware hiện hỗ trợ gửi cài đặt âm lượng và bật/tắt cảnh báo qua Wi-Fi trực tiếp. USB bridge chỉ đọc. ACK chỉ xác nhận firmware nhận lệnh; không xác nhận loa hoặc cảnh báo đã hoạt động.</p>
        <label className="device-volume-label" htmlFor="device-volume">
          <span>Mức âm lượng gửi tới firmware</span><strong>{requestedDeviceVolume}%</strong>
        </label>
        <input
          id="device-volume"
          className="device-volume-slider"
          type="range"
          min="0"
          max="100"
          step="5"
          value={requestedDeviceVolume}
          onChange={(event) => setRequestedDeviceVolume(Number(event.target.value))}
          disabled={!firmwareControlReady || deviceControlBusy}
          aria-label={`Mức âm lượng cần gửi ${requestedDeviceVolume} phần trăm`}
        />
        <ActionButton icon={SlidersHorizontal} tone="mint" disabled={!firmwareControlReady || deviceControlBusy} onClick={() => void sendDeviceControl({ command: 'set_volume', value: requestedDeviceVolume })}>
          {deviceControlBusy ? 'Đang gửi lệnh…' : 'Gửi mức âm lượng'}
        </ActionButton>
        <div className="device-control-pair">
          <ActionButton icon={CheckCircle} disabled={!firmwareControlReady || deviceControlBusy} onClick={() => void sendDeviceControl({ command: 'set_alerts', enabled: true })}>Bật cảnh báo</ActionButton>
          <ActionButton icon={X} tone="mint" disabled={!firmwareControlReady || deviceControlBusy} onClick={() => void sendDeviceControl({ command: 'set_alerts', enabled: false })}>Tắt cảnh báo</ActionButton>
        </div>
        {!firmwareControlReady && <p className="device-unknown">{firmwareControlUnavailableMessage} App không có lệnh bật MODE từ xa.</p>}
        {operationPaused && <p className="device-unknown">Thiết bị đang standby; cài đặt không làm thay đổi trạng thái MODE.</p>}
        {deviceControlError && <p className="form-error" role="alert">{deviceControlError}</p>}
        {deviceControlMessage && <p className="device-control-message" role="status" aria-live="polite">{deviceControlMessage}</p>}
      </section>

      <section className="device-section">
        <div className="section-title"><h2>Âm thanh thiết bị</h2><span>{audioAvailable ? (status.audio_ok ? 'SẴN SÀNG' : 'LỖI') : 'CHƯA CÓ TELEMETRY'}</span></div>
        <div className="device-audio"><SpeakerHigh size={21} /><div><strong>{audioAvailable ? (status.audio_ok ? 'Ngõ âm thanh đã khởi tạo' : 'Firmware báo âm thanh chưa sẵn sàng') : 'Chưa có trạng thái loa từ firmware'}</strong><span>{status?.device_capabilities?.audio_output ? 'Trạng thái theo firmware' : connection?.transport === 'firmware_wifi' ? 'Telemetry chỉ xác nhận khởi tạo; chưa xác nhận loa phát tiếng thực.' : 'Probe hiện tại chưa có điều khiển hoặc telemetry loa/rung.'}</span></div></div>
        <p className="device-unknown">PWA đọc câu trả lời qua iPhone. Chuyển TTS tới loa ESP32 hiện cần app iOS native và firmware Wi-Fi báo sẵn sàng.</p>
      </section>
      {window.location.hostname.endsWith('trycloudflare.com') && <p className="live-privacy live-privacy--tunnel"><LockKey size={16} /><span>Khung hình ESP32 đi qua Cloudflare Tunnel tới máy tính trước khi hiển thị trên iPhone.</span></p>}
      <p className="device-footnote">App yêu cầu làm mới trạng thái và JPEG mỗi 1,5 giây; tuổi dữ liệu được tính tiếp giữa các lần poll. Frame camera quá 1 giây sẽ bị khóa; detection và ToF quá 350 ms không còn được dùng làm ngữ cảnh. {Number.isFinite(cameraAge) ? `Tuổi frame: ${Math.round(cameraAge)} ms.` : ''} Tọa độ pin GPIO/ToF chưa được xác minh; app không gửi lệnh điều khiển tới probe chỉ đọc.</p>
    </div>
  )
}

function LiveScreen({ capabilities, onBack }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const activeRef = useRef(false)
  const abortRef = useRef(null)
  const pathEnabledRef = useRef(false)
  const cameraOpenAbortRef = useRef(null)
  const mountedRef = useRef(false)
  const startTimeRef = useRef(0)
  const frameCountRef = useRef(0)
  const wasRunningRef = useRef(false)
  const pathStreamIdRef = useRef('')
  const pathFrameIdRef = useRef(0)
  const [opening, setOpening] = useState(false)
  const [running, setRunning] = useState(false)
  const [detections, setDetections] = useState([])
  const [hazardZones, setHazardZones] = useState(null)
  const [pathHealth, setPathHealth] = useState(null)
  const [pathHealthError, setPathHealthError] = useState('')
  const [pathEnabled, setPathEnabled] = useState(false)
  const [pathResult, setPathResult] = useState(null)
  const [pathResultAt, setPathResultAt] = useState(null)
  const [segmentationMask, setSegmentationMask] = useState('')
  const [stableGuidanceState, setStableGuidanceState] = useState('unknown')
  const [hapticAlerts, setHapticAlerts] = useState(true)
  const [spokenAlerts, setSpokenAlerts] = useState(true)
  const [pathRequestError, setPathRequestError] = useState('')
  const [pathBusy, setPathBusy] = useState(false)
  const [detectionFrameAt, setDetectionFrameAt] = useState(null)
  const [freshnessNow, setFreshnessNow] = useState(() => performance.now())
  const [inferenceMs, setInferenceMs] = useState(null)
  const [streamFps, setStreamFps] = useState(0)
  const [error, setError] = useState('')
  const [cameraAnnouncement, setCameraAnnouncement] = useState('')
  const guidanceHistoryRef = useRef([])
  const lastGuidanceCueRef = useRef({ state: '', at: 0 })

  useEffect(() => {
    const announcement = getCameraLifecycleAnnouncement({
      opening,
      running,
      error,
      wasRunning: wasRunningRef.current,
    })
    wasRunningRef.current = running
    if (announcement) setCameraAnnouncement(announcement)
  }, [error, opening, running])

  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => setFreshnessNow(performance.now()), 250)
    return () => window.clearInterval(timer)
  }, [running])

  const detectionAgeMs = detectionFrameAt === null ? null : freshnessNow - detectionFrameAt
  const detectionsFresh = detectionAgeMs !== null && detectionAgeMs >= 0 && detectionAgeMs <= 1500
  const pathResultFresh = pathResultAt !== null && isPathResultFresh(
    pathResult, pathResultAt, freshnessNow,
  )

  useEffect(() => {
    if (!pathEnabled || !pathResultFresh || !pathResult) {
      setStableGuidanceState('unknown')
      guidanceHistoryRef.current = []
      return
    }
    const state = pathResult.state
    const history = appendGuidanceState(guidanceHistoryRef.current, state)
    guidanceHistoryRef.current = history
    if (!isGuidanceStable(history, state)) {
      if (state === 'unknown') setStableGuidanceState('unknown')
      return
    }
    setStableGuidanceState(state)
    const now = Date.now()
    const canSpeak = spokenAlerts && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
    const canVibrate = hapticAlerts && typeof navigator.vibrate === 'function'
    const cue = getGuidanceCue({
      state,
      lastCue: lastGuidanceCueRef.current,
      now,
      canSpeak,
      canVibrate,
    })
    if (!cue) return
    lastGuidanceCueRef.current = { state, at: now }
    if (cue.vibrate) {
      navigator.vibrate(cue.vibrationPattern)
    }
    if (cue.speak) {
      window.speechSynthesis.cancel()
      const spokenGuidance = state === 'unknown'
        ? 'Chưa đủ dữ liệu để chỉ hướng. Dừng lại và quét lại hướng camera.'
        : pathResult.label_vi
      const utterance = new SpeechSynthesisUtterance(spokenGuidance)
      utterance.lang = 'vi-VN'
      utterance.rate = 1.05
      window.speechSynthesis.speak(utterance)
    }
  }, [hapticAlerts, pathEnabled, pathResult, pathResultAt, pathResultFresh, spokenAlerts])

  const refreshPathHealth = useCallback(async (signal) => {
    setPathHealth(null)
    setPathHealthError('')
    try {
      const result = await api('/api/segmentation/health', { signal, timeoutMs: 3000 })
      setPathHealth(result)
      setPathHealthError('')
    } catch (err) {
      if (err.name === 'AbortError') return
      setPathHealth({ available: false, model_ready: false, calibration_status: 'unavailable' })
      setPathHealthError(err.message || 'Chưa kiểm tra được dịch vụ SegFormer trên máy chủ.')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refreshPathHealth(controller.signal)
    return () => controller.abort()
  }, [refreshPathHealth])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activeRef.current = false
      cameraOpenAbortRef.current?.abort()
      abortRef.current?.abort()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  const stopStream = () => {
    activeRef.current = false
    pathEnabledRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setRunning(false)
    setDetections([])
    setHazardZones(null)
    setPathEnabled(false)
    setPathResult(null)
    setPathResultAt(null)
    setSegmentationMask('')
    setStableGuidanceState('unknown')
    guidanceHistoryRef.current = []
    lastGuidanceCueRef.current = { state: '', at: 0 }
    window.speechSynthesis?.cancel?.()
    navigator.vibrate?.(0)
    setPathBusy(false)
    setDetectionFrameAt(null)
    setStreamFps(0)
    setInferenceMs(null)
  }

  const togglePathOccupancy = () => {
    if (pathEnabled) {
      pathEnabledRef.current = false
      setPathEnabled(false)
      setPathBusy(false)
      setPathResult(null)
      setPathResultAt(null)
      setSegmentationMask('')
      setStableGuidanceState('unknown')
      guidanceHistoryRef.current = []
      window.speechSynthesis?.cancel?.()
      navigator.vibrate?.(0)
      setPathRequestError('')
      return
    }
    if (!running) {
      setPathRequestError('Bật camera điện thoại trước khi chạy hướng dẫn lối đi.')
      return
    }
    if (!pathHealth?.available || pathHealth?.model_ready !== true) {
      setPathRequestError(pathServiceMessage)
      return
    }
    const instanceId = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    pathStreamIdRef.current = `iphone-${instanceId}`
    pathFrameIdRef.current = 0
    pathEnabledRef.current = true
    setPathResult(null)
    setPathResultAt(null)
    setSegmentationMask('')
    setStableGuidanceState('unknown')
    guidanceHistoryRef.current = []
    lastGuidanceCueRef.current = { state: '', at: 0 }
    setPathRequestError('')
    setPathEnabled(true)
  }

  // SANPO SegFormer is the active corridor model; YOLO remains only in object-box mode.

  const runDetectionLoop = async (ownerStream) => {
    while (isActiveCurrentCameraStream(ownerStream, streamRef.current, activeRef.current)) {
      const video = videoRef.current
      if (!video || video.readyState < 2 || !video.videoWidth) {
        await new Promise((resolve) => window.setTimeout(resolve, 120))
        continue
      }

      try {
        const scale = Math.min(1, 640 / video.videoWidth)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Chưa tạo được khung hình để nhận diện.')
        const capturedAt = performance.now()
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.68))
        if (!blob) throw new Error('Chưa tạo được ảnh camera để gửi model trên máy chủ.')
        if (!isActiveCurrentCameraStream(ownerStream, streamRef.current, activeRef.current)) break

        const body = new FormData()
        body.append('image', blob, 'live-frame.jpg')
        const pathRequested = pathEnabledRef.current
        let pathFrameId = null
        const pathStreamId = pathRequested ? pathStreamIdRef.current : null
        if (pathRequested) {
          pathFrameId = ++pathFrameIdRef.current
          body.append('stream_id', pathStreamId)
          body.append('frame_id', String(pathFrameId))
          setPathBusy(true)
        }
        const controller = new AbortController()
        abortRef.current = controller
        const result = await api(pathRequested ? '/api/segmentation/infer' : '/api/detect', {
          method: 'POST', body, signal: controller.signal, timeoutMs: 15000,
        })
        if (!isActiveCurrentCameraStream(ownerStream, streamRef.current, activeRef.current)) break
        const nextDetections = pathRequested ? [] : (result.detections || [])
        const nextHazardZones = !pathRequested && result.hazard_zones?.status === 'ready' ? result.hazard_zones : null
        frameCountRef.current += 1
        const elapsedSeconds = Math.max(0.001, (performance.now() - startTimeRef.current) / 1000)
        setDetections(nextDetections)
        setHazardZones(nextHazardZones)
        if (pathRequested) setSegmentationMask(`data:image/png;base64,${result.mask_png_base64}`)
        setDetectionFrameAt(capturedAt)
        setFreshnessNow(performance.now())
        setInferenceMs(Number(result.inference_ms) || null)
        setStreamFps(frameCountRef.current / elapsedSeconds)
        if (pathRequested && pathEnabledRef.current && pathStreamIdRef.current === pathStreamId && pathFrameId !== null) {
          const responseAt = performance.now()
          if (!pathResponseMatches(result, pathFrameId, pathStreamId) || !result.guidance) {
            setPathResult(null)
            setPathResultAt(null)
            setPathRequestError('Bỏ kết quả path occupancy không khớp với frame hiện tại.')
          } else {
            setPathResult({
              ...result.guidance,
              frame_id: result.frame_id,
              stream_id: result.stream_id,
              inference_ms: result.inference_ms,
              model_id: result.model_id,
              client_age_at_response_ms: getPathClientAgeAtResponseMs(capturedAt, responseAt, 0),
            })
            setPathResultAt(responseAt)
            setPathRequestError('')
          }
          setFreshnessNow(responseAt)
          setPathBusy(false)
        }
        setError('')
      } catch (err) {
        if (err.name === 'AbortError' || !isActiveCurrentCameraStream(ownerStream, streamRef.current, activeRef.current)) break
        if (pathEnabledRef.current) {
          setPathBusy(false)
          setPathResult(null)
          setPathResultAt(null)
          setSegmentationMask('')
          setStableGuidanceState('unknown')
          setPathRequestError(err.message || 'Mất kết nối với model SegFormer trên máy chủ.')
          abortRef.current = null
          await new Promise((resolve) => window.setTimeout(resolve, 700))
          continue
        }
        activeRef.current = false
        abortRef.current = null
        ownerStream.getTracks().forEach((track) => track.stop())
        if (streamRef.current === ownerStream) streamRef.current = null
        if (videoRef.current?.srcObject === ownerStream) videoRef.current.srcObject = null
        setDetections([])
        setHazardZones(null)
        setDetectionFrameAt(null)
        setPathEnabled(false)
        pathEnabledRef.current = false
        setSegmentationMask('')
        setStableGuidanceState('unknown')
        setPathResult(null)
        setPathResultAt(null)
        setPathRequestError('')
        setPathBusy(false)
        if (mountedRef.current) {
          setRunning(false)
          setError(err.message || 'Mất kết nối với dịch vụ nhận diện. Bạn thử bật lại nhé.')
        }
        break
      }

      await new Promise((resolve) => window.setTimeout(resolve,
        pathEnabledRef.current ? 100 : capabilities?.detector_provider === 'cloudflare' ? 950 : 180))
    }
  }

  const startStream = async () => {
    if (opening || running) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Trình duyệt chưa hỗ trợ camera trực tiếp. Trên iPhone, hãy mở app bằng Safari qua HTTPS.')
      return
    }
    setOpening(true)
    setError('')
    setDetections([])
    setHazardZones(null)
    setPathResult(null)
    setPathResultAt(null)
    setSegmentationMask('')
    setStableGuidanceState('unknown')
    guidanceHistoryRef.current = []
    lastGuidanceCueRef.current = { state: '', at: 0 }
    setDetectionFrameAt(null)
    try {
      let sanpoReady = pathServiceReady
      if (!sanpoReady) {
        try {
          const health = await api('/api/segmentation/health', { timeoutMs: 3500 })
          setPathHealth(health)
          sanpoReady = health.available === true && health.model_ready === true
        } catch {
          sanpoReady = false
        }
      }
      if (sanpoReady) {
        const instanceId = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        pathStreamIdRef.current = `iphone-${instanceId}`
        pathFrameIdRef.current = 0
      }
      pathEnabledRef.current = sanpoReady
      setPathEnabled(sanpoReady)
      if (!sanpoReady) setPathRequestError('SANPO chưa sẵn sàng; app đang dùng object detection YOLO/Moondream.')
      else setPathRequestError('')
      const cameraController = new AbortController()
      cameraOpenAbortRef.current = cameraController
      const media = await getUserMediaWithTimeout({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
        audio: false,
      }, { signal: cameraController.signal })
      if (cameraOpenAbortRef.current === cameraController) cameraOpenAbortRef.current = null
      if (!mountedRef.current) {
        media.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = media
      const video = videoRef.current
      if (!video) throw new Error('Chưa mở được phần xem camera.')
      video.srcObject = media
      await video.play()
      activeRef.current = true
      const handleCameraTrackEnded = () => {
        if (!shouldHandleCameraTrackEnd(media, streamRef.current, activeRef.current)) return
        activeRef.current = false
        abortRef.current?.abort()
        abortRef.current = null
        media.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        if (videoRef.current?.srcObject === media) videoRef.current.srcObject = null
        setRunning(false)
        pathEnabledRef.current = false
        setDetections([])
        setHazardZones(null)
        setPathEnabled(false)
        setSegmentationMask('')
        setStableGuidanceState('unknown')
        setPathResult(null)
        setPathResultAt(null)
        setPathRequestError('')
        setPathBusy(false)
        setDetectionFrameAt(null)
        setStreamFps(0)
        setInferenceMs(null)
        setError('Luồng camera đã kết thúc. Kiểm tra quyền camera rồi bấm bật lại.')
      }
      const videoTracks = media.getVideoTracks()
      videoTracks.forEach((track) => track.addEventListener('ended', handleCameraTrackEnded, { once: true }))
      if (videoTracks.length === 0 || videoTracks.some((track) => track.readyState === 'ended')) {
        handleCameraTrackEnded()
        return
      }
      startTimeRef.current = performance.now()
      setFreshnessNow(startTimeRef.current)
      frameCountRef.current = 0
      setRunning(true)
      void runDetectionLoop(media)
    } catch (err) {
      if (err.name === 'AbortError' || !mountedRef.current) return
      pathEnabledRef.current = false
      setPathEnabled(false)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setError(cameraErrorMessage(err))
    } finally {
      cameraOpenAbortRef.current = null
      if (mountedRef.current) setOpening(false)
    }
  }

  const cloudDetector = capabilities?.detector_provider === 'cloudflare'
  const detectorName = pathEnabled ? 'SegFormer-B2 / SANPO' : cloudDetector ? 'Moondream cloud' : 'YOLO server'
  const usesCloudflareTunnel = window.location.hostname.endsWith('trycloudflare.com')
  const statusText = error ? 'Luồng đã dừng' : running ? pathEnabled
    ? (pathResultFresh ? 'SegFormer đang phân tích vùng đường' : 'Đang chờ kết quả SANPO mới')
    : (detectionsFresh ? (detections.length ? `Đang thấy ${detections.length} vật thể · khung ${detectorName} ${(detectionAgeMs / 1000).toFixed(1)} giây trước` : 'Khung mới chưa thấy vật thể rõ') : 'Đang chờ kết quả nhận diện mới')
    : opening ? 'Đang mở camera…' : 'Chưa bật camera'
  const pathServiceReady = pathHealth?.available === true && pathHealth?.model_ready === true
  const pathServiceMessage = pathHealth === null
    ? pathHealthError || 'Đang kiểm tra dịch vụ phân tích lối đi…'
    : pathServiceReady
      ? `Dịch vụ phân tích lối đi đã sẵn sàng trên ${pathHealth.device || 'máy chủ'}; gợi ý vẫn đang thử nghiệm.`
      : 'Dịch vụ phân tích lối đi chưa sẵn sàng trên máy chủ.'
  const pathStateLabels = {
    unknown: 'Chưa đủ dữ liệu · dừng lại và quét lại',
    center: 'Giữ hướng giữa (ứng viên)',
    left: 'Lệch nhẹ sang trái (ứng viên)',
    right: 'Lệch nhẹ sang phải (ứng viên)',
    stop: 'Dừng lại, chưa thấy hướng rõ',
  }
  const pathResultLabel = pathResultFresh && pathResult
    ? (pathStateLabels[stableGuidanceState] || 'Đang ổn định hướng…')
    : 'Đang chờ kết quả mới'

  return (
    <div className="live-screen page-pad">
      <header className="subpage-top"><button className="back-button" onClick={onBack}><ArrowLeft size={21} />Về trang chính</button><span className={`live-state ${running ? 'live-state--on' : ''}`}><span />{running ? pathEnabled ? 'SANPO SEGFORMER' : cloudDetector ? 'MOONDREAM CLOUD' : 'YOLO TRỰC TIẾP' : 'TẠM DỪNG'}</span></header>
      <div className="live-heading"><p className="eyebrow">CAMERA + PHÂN TÍCH {pathEnabled ? 'LỐI ĐI' : cloudDetector ? 'TRÊN CLOUD' : 'VẬT THỂ'}</p><h1>Xem lối đi<br /><em>phía trước.</em></h1><p>{pathEnabled ? 'Ảnh được phân tích trên máy chủ rồi tóm tắt thành ba vùng trái, giữa và phải.' : cloudDetector ? 'Khung hình được gửi lên Cloudflare tối đa khoảng một lần mỗi giây để nhận diện vật thể.' : 'Khung hình được gửi lên máy chủ để nhận diện vật thể; bật chỉ dẫn lối đi ở thẻ bên dưới tiêu đề.'}</p></div>

      <section className="path-occupancy path-occupancy--featured" aria-labelledby="path-guidance-title">
        <div className="section-title"><h2 id="path-guidance-title">Chỉ dẫn lối đi</h2><span>{pathEnabled ? 'ĐANG THEO DÕI' : 'PHÂN TÍCH TRÊN MÁY CHỦ'}</span></div>
        <p className="path-occupancy-intro">Bật camera để nhận gợi ý cho ba vùng trái, giữa và phải. Kết quả sẽ hiện tại đây, có thể đọc thành tiếng; nếu ảnh chưa đủ rõ, app sẽ yêu cầu dừng và quét lại.</p>
        <div className={`path-service-state${pathServiceReady ? ' path-service-state--ready' : ''}`}>
          <span>{pathEnabled ? 'ĐANG CHỈ DẪN' : pathServiceReady ? 'MODEL SẴN SÀNG' : pathHealth === null ? 'ĐANG KIỂM TRA MODEL' : 'MODEL CHƯA SẴN SÀNG'}</span>
          <p>{pathEnabled ? pathResultFresh ? pathResultLabel : pathBusy ? 'Đang phân tích ảnh mới…' : 'Đang chờ khung hình đầu tiên.' : !running && pathServiceReady ? 'Bấm “Bắt đầu camera + chỉ dẫn” để xem ba vùng lối đi.' : pathServiceMessage}</p>
          <button type="button" className="path-refresh" onClick={() => void refreshPathHealth()} disabled={pathEnabled}>Kiểm tra lại</button>
        </div>
        <ActionButton
          icon={pathEnabled ? X : Eye}
          tone={pathEnabled ? 'mint' : 'dark'}
          className="path-toggle"
          disabled={opening || (running && !pathEnabled && !pathServiceReady)}
          onClick={() => { if (!running) void startStream(); else togglePathOccupancy() }}
        >
          {opening ? 'Đang kết nối camera…' : pathEnabled ? 'Tắt chỉ dẫn lối đi' : running ? pathBusy ? 'Đang gửi ảnh…' : 'Bật chỉ dẫn lối đi' : 'Bắt đầu camera + chỉ dẫn'}
        </ActionButton>
        {pathResultFresh && pathEnabled && <div className={`path-result path-result--featured${pathResult ? ` path-result--${pathResult.state}` : ''}`}>
          <div className="path-result-heading"><strong>{pathResultLabel}</strong><span>{pathResult ? `${pathResult.inference_ms} ms` : 'UNKNOWN'}</span></div>
          <p>{pathRequestError || (pathResult ? `Khung ${pathResult.frame_id} · ${pathResult.reason || 'SegFormer-B2'} · gợi ý thử nghiệm` : 'Kết quả chưa đủ mới để đưa ra gợi ý.')}</p>
          <div className="sanpo-zone-grid">{Object.entries(pathResult?.zones || {}).map(([zone, metrics]) => <div key={zone} className={`sanpo-zone sanpo-zone--${metrics.status}`}><strong>{zone === 'left' ? 'Trái' : zone === 'right' ? 'Phải' : 'Giữa'}</strong><span>{metrics.status === 'open_candidate' ? 'Lối đi có thể mở' : metrics.status === 'blocked_candidate' ? 'Có dấu hiệu bị chắn' : 'Chưa rõ'}</span><small>đi được {Math.round(metrics.walkable_score * 100)}% · chắn {Math.round(metrics.blocker_share * 100)}%</small></div>)}</div>
          <small>Hướng ổn định sau 3/5 khung hình. Đây là gợi ý nghiên cứu, chưa xác nhận an toàn trên camera/đường đi thực tế.</small>
        </div>}
        {!pathEnabled && pathRequestError && <p className="path-occupancy-error" role="status">{pathRequestError}</p>}
        <div className="guidance-alert-settings"><label><input type="checkbox" checked={spokenAlerts} onChange={(event) => setSpokenAlerts(event.target.checked)} /> Đọc hướng dẫn khi đổi trạng thái</label><label><input type="checkbox" checked={hapticAlerts} onChange={(event) => setHapticAlerts(event.target.checked)} /> Rung khi trình duyệt hỗ trợ {typeof navigator.vibrate === 'function' ? '(có)' : '(không có Vibration API)'}</label></div>
        <p className="path-occupancy-note">Lối đi được ước lượng từ ảnh, chưa ghép khoảng cách ToF; iPhone Safari thường không hỗ trợ rung. Nếu model chưa sẵn sàng, app sẽ hiện trạng thái thay vì giả lập chỉ dẫn.</p>
      </section>

      <div className={`live-stage ${running ? 'live-stage--active' : ''}`}>
        <video ref={videoRef} playsInline muted autoPlay aria-label="Camera sau đang được model trên máy chủ phân tích" />
        {pathEnabled && segmentationMask && <img className="segmentation-live-mask" src={segmentationMask} alt="Lớp phủ phân đoạn ngữ nghĩa SANPO" />}
        <svg className="detection-overlay" viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          {(detectionsFresh ? detections : []).slice(0, 12).map((item, index) => {
            const [x1, y1, x2, y2] = item.box || [0, 0, 0, 0]
            const label = `${item.label_vi || item.label} ${Math.round((item.confidence || 0) * 100)}%`
            const tagWidth = Math.max(0.13, Math.min(0.46, label.length * 0.014 + 0.035))
            const tagY = Math.max(0.008, y1 - 0.042)
            const tagX = Math.max(0.005, Math.min(x1, 0.995 - tagWidth))
            return <g key={`${item.label}-${index}`}><rect className="detection-box" x={x1} y={y1} width={Math.max(0, x2 - x1)} height={Math.max(0, y2 - y1)} rx="0.012" /><rect className="detection-tag" x={tagX} y={tagY} width={tagWidth} height="0.038" rx="0.008" /><text className="detection-text" x={tagX + 0.012} y={tagY + 0.026} fontSize="0.024">{label}</text></g>
          })}
        </svg>
        {!running && <div className="live-placeholder"><span className="placeholder-icon"><Camera size={33} /></span><strong>{opening ? 'Đang mở camera…' : 'Camera đang tạm dừng'}</strong><span>{error || 'Bấm bắt đầu để cấp quyền camera và nhận diện trực tiếp.'}</span></div>}
        {running && <><span className="live-camera-badge"><span />CAMERA SAU</span><span className="live-yolo-badge">{pathEnabled ? `SANPO ${streamFps.toFixed(1)} fps` : detectionsFresh ? `${detectorName} ${streamFps.toFixed(1)} fps` : 'ĐANG CHỜ KẾT QUẢ'}</span></>}
        <span className="frame-corner frame-corner--tl" /><span className="frame-corner frame-corner--tr" /><span className="frame-corner frame-corner--bl" /><span className="frame-corner frame-corner--br" />
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{cameraAnnouncement}{pathEnabled && pathResultFresh ? ` ${pathResultLabel}` : ''}</div>
      <div className="live-metrics" role="group" aria-label="Trạng thái camera và thời gian suy luận"><div><span>Trạng thái</span><strong>{statusText}</strong></div><div><span>{pathEnabled ? 'SegFormer xử lý' : cloudDetector ? 'Model xử lý' : 'YOLO xử lý'}</span><strong>{inferenceMs === null ? '—' : `${inferenceMs} ms`}</strong></div></div>
      {(running || !pathServiceReady) && <ActionButton icon={running ? X : opening ? SpinnerGap : Eye} tone={running ? 'mint' : 'dark'} className="live-toggle" disabled={opening} onClick={running ? stopStream : startStream}>{running ? 'Dừng camera' : opening ? 'Đang kết nối…' : 'Chỉ nhận diện vật thể'}</ActionButton>}

      {!pathEnabled && <section className="live-detections">
        <div className="section-title"><h2>{cloudDetector ? 'Moondream đang nhận diện' : 'YOLO đang nhận diện'}</h2><span>{detectionsFresh ? detections.length : '—'}</span></div>
        <p className="live-empty">Nhóm điều hướng chỉ phân loại nhãn model; chưa hiệu chuẩn để kết luận vật thể chắn lối.</p>
        {detectionsFresh && detections.length ? <><p className="live-empty">Hộp và nhãn thuộc khung {detectorName} đã gửi, không nhất thiết là đúng khoảnh khắc đang xem.</p><ul className="object-list">{detections.slice(0, 5).map((item, index) => <li key={`${item.label}-${index}`}><span className="object-glyph"><Eye size={17} /></span><span className="object-name">{item.label_vi || item.label}<small>{item.navigation_role_vi || 'Chưa gán vai trò điều hướng'} · {item.region_vi || 'trong khung hình'}</small></span>{Number.isFinite(item.confidence) && <span className="object-confidence">{Math.round(item.confidence * 100)}%</span>}</li>)}</ul></> : <p className="live-empty">{running ? detectionFrameAt === null ? 'Đang chờ kết quả nhận diện đầu tiên.' : !detectionsFresh ? 'Khung nhận diện cũ đã ẩn; đang chờ kết quả mới.' : 'Chưa thấy vật thể rõ trong khung hình mới nhất.' : 'Kết quả sẽ hiện ở đây khi bạn bật theo dõi.'}</p>}
      </section>}

      {detectionsFresh && Array.isArray(hazardZones?.zones) && <section className="live-zones">
        <div className="section-title"><h2>Có thể có vật cản ở</h2><span>3 vùng</span></div>
        <div className="live-zone-grid">{hazardZones.zones.map((zone) => <div className={`live-zone-card${zone.is_hazard ? ' live-zone-card--hazard' : ''}`} key={zone.id}>
          <strong>{zone.label_vi === 'bên trái' ? 'Bên trái' : zone.label_vi === 'bên phải' ? 'Bên phải' : 'Ở giữa'}</strong>
          <span>{zone.is_hazard ? 'Có thể có vật cản' : 'Chưa nhận ra vật cản'}</span>
          <small>{Math.round((zone.hazard_probability || 0) * 100)}% khả năng</small>
        </div>)}</div>
        <p className="live-empty">MobileNet phân vùng ảnh; số % chưa phải khoảng cách. Safari chưa đọc được LiDAR — cần app iOS native để ghép từng vùng với chiều sâu ARKit.</p>
      </section>}

      <p className="live-model-note">Luồng object detection YOLO/Moondream vẫn có thể dùng riêng, nhưng hướng dẫn trái/giữa/phải ở trên chạy bằng SegFormer-B2 fine-tune SANPO trên máy chủ. Kết quả phân lớp theo từng pixel không tự chứng minh lối đi an toàn.</p>
      <div className="lidar-state"><WarningCircle size={19} /><p><strong>Khoảng cách chưa được ghép vào cảnh báo này</strong><br />Web trên iPhone không đọc được LiDAR/ARKit depth. Luồng SANPO hiện chỉ phân tích camera; muốn biết vật cách bao xa cần ghép telemetry VL53L1X từ ESP32 cùng timestamp/frame, qua Wi‑Fi tới backend. Hướng đó chưa được bật trong build này.</p></div>
      <p className={`live-privacy ${usesCloudflareTunnel ? 'live-privacy--tunnel' : ''}`}><LockKey size={16} /><span>{pathEnabled ? usesCloudflareTunnel ? 'Khung hình đi qua Cloudflare Tunnel tới máy tính của bạn; SegFormer chạy tại máy tính và ảnh không được lưu.' : 'SegFormer chạy trên máy tính của bạn; các khung hình không được lưu.' : cloudDetector ? 'Khi theo dõi object mode, khung hình được gửi lên Cloudflare để Moondream xử lý; khung hình không lưu trong hồ sơ.' : usesCloudflareTunnel ? 'Khi theo dõi object mode, khung hình đi qua Cloudflare Tunnel tới máy tính của bạn để YOLO xử lý.' : 'YOLO chạy trên máy tính của bạn; các khung hình không được lưu.'} Mô hình hỏi đáp không bị gọi lặp lại trong lúc stream.</span></p>
    </div>
  )
}

function CaptureScreen({ onBack, onCaptured }) {
  const videoRef = useRef(null)
  const [cameraError, setCameraError] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    let live = true
    let activeStream
    const cameraController = new AbortController()
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(`${cameraUnavailableMessage()} Bạn cũng có thể chọn ảnh có sẵn.`)
      setBusy(false)
      return
    }
    getUserMediaWithTimeout(
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } }, audio: false },
      { signal: cameraController.signal },
    )
      .then((media) => {
        activeStream = media
        if (!live) return media.getTracks().forEach((track) => track.stop())
        setBusy(false)
        if (videoRef.current) {
          videoRef.current.srcObject = media
          videoRef.current.play().catch(() => {
            if (live) {
              media.getTracks().forEach((track) => track.stop())
              if (videoRef.current) videoRef.current.srcObject = null
              setReady(false)
              setCameraError('Safari chưa phát được hình camera. Thử mở lại hoặc chọn ảnh có sẵn.')
            }
          })
        }
      })
      .catch((error) => {
        if (live) {
          setCameraError(`${cameraErrorMessage(error)} Bạn vẫn có thể chọn ảnh có sẵn.`)
          setBusy(false)
        }
      })
    return () => {
      live = false
      cameraController.abort()
      activeStream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const capture = () => {
    const video = videoRef.current
    if (!video?.videoWidth || video.paused || cameraError) return
    const canvas = document.createElement('canvas')
    const ratio = Math.min(1, 1600 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * ratio)
    canvas.height = Math.round(video.videoHeight * ratio)
    const context = canvas.getContext('2d')
    if (!context) {
      setCameraError('Chưa tạo được ảnh từ camera. Thử lại hoặc chọn ảnh có sẵn.')
      return
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (blob) onCaptured(blob)
      else setCameraError('Chưa tạo được JPEG từ camera. Thử lại hoặc chọn ảnh có sẵn.')
    }, 'image/jpeg', 0.88)
  }

  const chooseFile = (event) => {
    const file = event.target.files?.[0]
    if (file) onCaptured(file)
  }

  return (
    <div className="capture-screen page-pad">
      <header className="subpage-top"><button className="back-button" onClick={onBack}><ArrowLeft size={21} />Về trang chính</button><span className="step-label">01 / 02</span></header>
      <div className="capture-heading"><p className="eyebrow">NHÌN CHẬM MỘT CHÚT</p><h1>Đưa camera<br /><em>về phía trước.</em></h1><p>Giữ máy ổn định và chụp điều bạn muốn hỏi.</p></div>
      <div className={`camera-frame ${ready ? 'camera-frame--ready' : ''}`}>
        <video ref={videoRef} playsInline muted autoPlay onPlaying={() => setReady(true)} aria-label="Hình ảnh trực tiếp từ camera sau" />
        {(!ready || cameraError) && <div className="camera-placeholder"><span className="placeholder-icon"><Camera size={34} /></span><strong>{busy ? 'Đang mở camera…' : 'Camera chưa mở'}</strong><span>{cameraError || 'Chờ một chút để camera sẵn sàng.'}</span></div>}
        <span className="frame-corner frame-corner--tl" /><span className="frame-corner frame-corner--tr" /><span className="frame-corner frame-corner--bl" /><span className="frame-corner frame-corner--br" />
        {ready && <div className="camera-live-label"><span />CAMERA SAU</div>}
      </div>
      <div className="camera-actions">
        <label className="file-pick"><ImageSquare size={20} /><span>Chọn ảnh</span><input type="file" accept="image/*" capture="environment" onChange={chooseFile} aria-label="Chọn ảnh từ điện thoại" /></label>
        <button className="shutter" onClick={capture} disabled={!ready || Boolean(cameraError)} aria-label="Chụp ảnh"><span /></button>
        <span className="camera-hint">Ảnh không lưu vào lịch sử</span>
      </div>
      {cameraError && <p className="camera-help"><Info size={18} />Camera cần kết nối HTTPS trên iPhone. Bạn vẫn có thể chọn ảnh trong thư viện; mic trên bàn phím iPhone dùng để đọc câu hỏi thành chữ.</p>}
    </div>
  )
}

function ReviewScreen({ photo, question, setQuestion, busy, recording, onBack, onAnalyze, onRecord, capabilities }) {
  const questionInputRef = useRef(null)
  const canRecord = Boolean(capabilities?.transcription_ready)
  const usesCloudflareTunnel = window.location.hostname.endsWith('trycloudflare.com')
  const questionHint = canRecord
    ? 'Chạm micro để ghi âm, hoặc dùng mic trên bàn phím iPhone. Ghi âm trong app gửi tới máy chủ phiên âm.'
    : 'Chạm nút mic để mở bàn phím iPhone, rồi dùng mic Dictation. Không cần module mic rời hoặc khóa API phiên âm.'
  const imageRoute = !question.trim()
    ? capabilities?.detector_provider === 'cloudflare'
      ? 'Ảnh được nhận diện bằng Moondream trên Cloudflare; Vision chỉ trả lời theo câu hỏi khi bạn nhập câu hỏi.'
      : 'Ảnh chỉ chạy qua YOLO; Vision chỉ nhận ảnh khi bạn đặt câu hỏi.'
    : capabilities?.vision_provider === 'cloudflare' || capabilities?.vision_provider === 'openai'
      ? `Ảnh và câu hỏi được gửi tới ${capabilities?.vision_model || 'mô hình trợ lý'} trên ${capabilities?.vision_provider === 'openai' ? 'OpenAI API' : 'Cloudflare'} để trả lời.`
    : capabilities?.vision_provider === 'ollama'
      ? 'Ảnh và nhãn YOLO được gửi tới Qwen3-VL trên máy tính.'
      : capabilities?.vision_provider === 'openai'
        ? 'Ảnh và nhãn YOLO được gửi tới OpenAI để trả lời.'
        : 'Ảnh được xử lý bằng YOLO; hỏi tự do cần Vision LLM.'
  return (
    <div className="review-screen page-pad">
      <header className="subpage-top"><button className="back-button" onClick={onBack}><ArrowLeft size={21} />Chụp lại</button><span className="step-label">02 / 02</span></header>
      <div className="review-heading"><p className="eyebrow">BẠN MUỐN BIẾT ĐIỀU GÌ?</p><h1>Hỏi theo cách<br /><em>của bạn.</em></h1></div>
      <div className="review-photo"><img src={photo?.url} alt="Ảnh bạn vừa chọn để phân tích" /><span className="photo-badge"><Check size={15} weight="bold" />Ảnh đã chọn</span></div>
      <label className="question-label" htmlFor="question">Câu hỏi của bạn <span>không bắt buộc</span></label>
      <div className="question-box">
        <textarea ref={questionInputRef} id="question" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={400} placeholder="Ví dụ: Trước mặt tôi có gì?" rows={3} autoCapitalize="sentences" enterKeyHint="send" aria-describedby="question-hint" />
        <button className={`record-button ${recording ? 'is-recording' : ''}`} onClick={() => { if (!canRecord) questionInputRef.current?.focus(); onRecord() }} aria-label={recording ? 'Dừng ghi âm' : canRecord ? 'Ghi âm câu hỏi bằng mic iPhone' : 'Mở bàn phím để dùng mic iPhone'} title={recording ? 'Dừng ghi âm' : canRecord ? 'Ghi âm câu hỏi' : 'Dùng mic trên bàn phím iPhone'}>{recording ? <MicrophoneSlash size={22} /> : <Microphone size={22} />}</button>
      </div>
      <p id="question-hint" className="field-hint">{questionHint}</p>
      <ActionButton icon={busy ? SpinnerGap : Sparkle} className="analyze-button" disabled={busy} onClick={onAnalyze}>{busy ? 'Đang xem ảnh…' : 'Nhìn giúp tôi'}</ActionButton>
      <p className={`upload-note ${usesCloudflareTunnel ? 'upload-note--tunnel' : ''}`}>
        {usesCloudflareTunnel ? <Info size={17} aria-hidden="true" /> : <LockKey size={16} aria-hidden="true" />}
        <span>{usesCloudflareTunnel && <><strong>Ảnh đi qua Cloudflare Tunnel tới máy tính.</strong> </>}Ảnh không lưu. {imageRoute} Câu hỏi và câu trả lời được lưu ở Lịch sử.</span>
      </p>
    </div>
  )
}

function ResultScreen({ photo, result, onBack, onSpeak, onAgain }) {
  const detections = result?.detections || []
  return (
    <div className="result-screen page-pad">
      <header className="subpage-top"><button className="back-button" onClick={onBack}><ArrowLeft size={21} />Xong</button><span className="result-mark"><CheckCircle size={18} weight="fill" />ĐÃ XEM ẢNH</span></header>
      <div className="result-hero">
        <div className="result-photo"><img src={photo?.url} alt="Ảnh vừa được phân tích" /></div>
        <div className="result-greeting"><span className="result-spark"><Sparkle size={18} weight="fill" /></span><p className="eyebrow">MÌNH NHÌN THẤY</p><h1>Cùng nhìn<br /><em>một chút nhé.</em></h1></div>
      </div>
      <article className="answer-card" aria-live="polite">
        <div className="answer-heading"><span className="answer-avatar"><Eye size={20} weight="duotone" /></span><span>Rõ nói rằng</span><button className="icon-button speak-button" onClick={onSpeak} aria-label="Nghe câu trả lời"><SpeakerHigh size={21} /></button></div>
        <p className="answer-text">{result?.answer || 'Chưa có câu trả lời.'}</p>
        {result?.vision_used && <span className="answer-source"><Sparkle size={14} />{result.vision_provider === 'ollama' ? 'Qwen3-VL cục bộ đã xem ảnh' : result.vision_provider === 'cloudflare' ? 'Qwen 3.8 27B trên Cloudflare đã xem ảnh' : result.vision_provider === 'openai' ? 'GPT-6 Luna trên OpenAI đã xem ảnh' : 'Vision LLM đã xem ảnh'}</span>}
        {result?.vision_error && <span className="answer-source answer-source--warning"><Info size={14} />{result.vision_error}</span>}
      </article>
      <section className="objects-section">
        <div className="section-title"><h2>Các vật thể nhận diện được</h2><span>{detections.length}</span></div>
        {detections.length ? <ul className="object-list">{detections.slice(0, 8).map((item, index) => <li key={`${item.label}-${index}`}><span className="object-glyph"><Eye size={18} /></span><span className="object-name">{item.label_vi || item.label}<small>{item.region_vi}</small></span>{Number.isFinite(item.confidence) && <span className="object-confidence">{Math.round(item.confidence * 100)}%</span>}</li>)}</ul> : <p className="empty-object"><Info size={18} />Chưa nhận diện chắc được vật thể nào trong ảnh.</p>}
      </section>
      <div className="distance-note"><Info size={19} /><p><strong>Chưa có số đo khoảng cách.</strong> Bản web chưa đọc được LiDAR của iPhone. Mình không ước lượng mét từ kích thước vật thể trong ảnh.</p></div>
      <ActionButton icon={Camera} tone="mint" className="again-button" onClick={onAgain}>Chụp điều khác</ActionButton>
    </div>
  )
}

function HistoryScreen({ items, loading, error, onBack, onClear, onRetry }) {
  const formatter = new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
  return (
    <div className="history-screen page-pad">
      <header className="topbar"><div><p className="eyebrow">GÓC RIÊNG CỦA BẠN</p><h1>Lần mình<br /><em>cùng quan sát.</em></h1></div><span className="page-stamp"><ClockCounterClockwise size={24} /></span></header>
      {loading ? <div className="empty-history" role="status"><SpinnerGap size={28} /><h2>Đang tải lịch sử</h2><p>Đợi máy chủ gửi các lần quan sát đã lưu.</p></div> : error && !items.length ? <div className="empty-history" role="alert"><div className="empty-history-art"><WarningCircle size={34} /></div><h2>Chưa tải được lịch sử</h2><p>{error}</p><button className="text-link" onClick={onRetry}>Thử lại <ArrowRight size={17} /></button></div> : items.length ? <>
        {error && <div className="form-error history-error" role="alert"><WarningCircle size={18} /><span>{error}</span><button className="text-link" onClick={onRetry}>Tải lại</button></div>}
        <div className="history-meta"><span>{items.length} lần gần đây</span><button onClick={onClear}><Trash size={17} />Xóa lịch sử</button></div>
        <div className="history-list">{items.map((item) => <article className="history-entry" key={item.id}><div className="history-entry-top"><span className="history-time">{formatter.format(new Date(item.created_at))}</span><span className="history-indicator"><Check size={14} /></span></div><h2>{item.question || 'Mô tả ảnh'}</h2><p>{item.answer}</p>{item.labels?.length > 0 && <div className="history-tags">{item.labels.slice(0, 3).map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>}</article>)}</div>
      </> : <div className="empty-history"><div className="empty-history-art"><ClockCounterClockwise size={34} weight="duotone" /></div><h2>Một trang giấy mới.</h2><p>Ảnh không lưu. Câu hỏi và câu trả lời bằng chữ sẽ xuất hiện ở đây sau lần quan sát đầu tiên.</p><button className="text-link" onClick={onBack}>Về trang chính <ArrowRight size={17} /></button></div>}
      <p className="history-footnote"><LockKey size={15} />Ảnh không lưu. Câu hỏi và câu trả lời được lưu ở lịch sử này.</p>
    </div>
  )
}

function ProfileScreen({ user, profile, capabilities, capabilitiesError, refreshingCapabilities, saving, onBack, onUpdate, onSignOut, onRefresh, onAdvanced }) {
  const { realtimeReady: voiceRealtimeReady, recordedServerReady: voiceRecordedReady, ready: voiceReady } = getVoiceReadiness(capabilities)
  const assistantModelLabel = capabilities?.vision_model
    ? `${capabilities.vision_model}${capabilities.vision_provider === 'ollama' ? ' trên laptop' : capabilities.vision_provider === 'cloudflare' ? ' trên Cloudflare' : capabilities.vision_provider === 'openai' ? ' trên OpenAI' : ''}`
    : 'mô hình hỏi đáp AI'
  const set = (key, value) => { if (!saving) onUpdate({ ...profile, [key]: value }) }
  return (
    <div className="profile-screen page-pad">
      <header className="topbar"><div><p className="eyebrow">TÙY CHỈNH THEO BẠN</p><h1>Hồ sơ<br /><em>và trợ năng.</em></h1></div><span className="page-stamp"><SlidersHorizontal size={24} /></span></header>
      <section className="account-card"><div className="account-avatar">{(user.display_name || 'R').slice(0, 1).toLocaleUpperCase('vi')}</div><div><strong>{user.display_name}</strong><span>@{user.username}</span></div><CheckCircle size={20} weight="fill" className="account-check" /></section>

      <section className="settings-section"><p className="settings-eyebrow">DỄ ĐỌC HƠN</p>
        <div className="setting-row"><span className="setting-icon setting-icon--peach"><Eye size={20} /></span><div className="setting-copy"><strong>Cỡ chữ</strong><span>Tùy theo điều mắt bạn cần</span></div><div className="text-stepper"><button aria-label="Giảm cỡ chữ" disabled={saving || profile.text_scale <= 0.9} onClick={() => set('text_scale', Math.max(0.9, Number((profile.text_scale - 0.1).toFixed(1))))}>−</button><span>{Math.round(profile.text_scale * 100)}%</span><button aria-label="Tăng cỡ chữ" disabled={saving || profile.text_scale >= 1.3} onClick={() => set('text_scale', Math.min(1.3, Number((profile.text_scale + 0.1).toFixed(1))))}>+</button></div></div>
        <ToggleRow Icon={profile.high_contrast ? Sun : Moon} tone="lavender" title="Tương phản rõ" description="Làm chữ và nút nổi bật hơn" checked={profile.high_contrast} disabled={saving} onChange={(value) => set('high_contrast', value)} />
        <ToggleRow Icon={SpeakerHigh} tone="mint" title="Đọc câu trả lời" description="Ưu tiên VieNeu trên máy chủ khi sẵn sàng" checked={profile.speak_answers} disabled={saving} onChange={(value) => set('speak_answers', value)} />
      </section>

      <section className="settings-section connection-section"><div className="settings-head"><p className="settings-eyebrow">KHẢ NĂNG TRÊN THIẾT BỊ</p><button className="refresh-button" onClick={onRefresh} disabled={refreshingCapabilities} aria-label="Kiểm tra lại kết nối"><SpinnerGap size={18} /></button></div>
        {capabilitiesError && <p className="form-error" role="alert">{capabilitiesError}</p>}
        <StatusRow title="Nhận diện camera iPhone" detail={capabilities?.detector_ready ? `${capabilities.detector_provider === 'cloudflare' ? 'Moondream 3.1 trên Cloudflare' : 'YOLO server trên máy tính'}; chưa đo khoảng cách` : capabilitiesError || (capabilities ? 'Detector chưa sẵn sàng; model ESP32 cần firmware đã nạp và đang chạy' : 'Chưa nhận được trạng thái máy chủ app')} connected={!!capabilities?.detector_ready} />
        <StatusRow title="Mô hình trò chuyện AI" detail={capabilities?.vision_ready ? `${capabilities.vision_provider === 'ollama' ? 'Chạy cục bộ' : capabilities.vision_provider === 'cloudflare' ? 'Cloudflare' : 'OpenAI'} · ${capabilities.vision_model}` : capabilitiesError || (capabilities ? 'Mô hình AI chưa sẵn sàng' : 'Chưa nhận được trạng thái máy chủ app')} connected={!!capabilities?.vision_ready} />
        <StatusRow title="Nhận dạng giọng nói câu hỏi" detail={capabilities?.transcription_ready ? `${capabilities.transcription_model || capabilities.transcription_provider || 'STT trên máy chủ'} đã sẵn sàng` : capabilities?.voice_realtime_ready ? `${capabilities.voice_stt_model || 'STT realtime trên máy chủ'} đã sẵn sàng` : capabilitiesError || (capabilities ? 'STT trên máy chủ chưa sẵn sàng; Dictation bàn phím chỉ nhập chữ' : 'Chưa nhận được trạng thái máy chủ app')} connected={!!capabilities?.transcription_ready || !!capabilities?.voice_realtime_ready} />
        <StatusRow title="Thoại trực tiếp" detail={voiceRealtimeReady ? `${capabilities.voice_stt_model || 'STT realtime'} → ${assistantModelLabel}` : voiceRecordedReady ? `Ghi âm từng lượt → ${capabilities.transcription_model || capabilities.transcription_provider || 'STT trên máy chủ'} → ${assistantModelLabel}` : capabilities?.vision_ready ? 'STT/thoại trên máy chủ chưa sẵn sàng' : 'Cấu hình mô hình trợ lý AI trước'} connected={voiceReady} />
        <StatusRow title="LiDAR iPhone 12 Pro Max" detail="Cần app iOS native dùng ARKit" connected={false} />
        {capabilities && !capabilities.vision_ready && <div className="setup-note"><Info size={18} /><p>Mô hình GPT-6 Luna chưa sẵn sàng. Vào Cấu hình AI nâng cao để nhập OpenAI API key; key chỉ lưu ở máy chủ.</p></div>}
        {capabilities && !capabilities.transcription_ready && !capabilities.voice_realtime_ready && <div className="setup-note"><Info size={18} /><p>Thoại trong app cần STT trên máy chủ. Dictation của bàn phím chỉ nhập văn bản, không thay thế luồng hỏi–đáp bằng giọng nói.</p></div>}
      </section>
      <section className="settings-section"><p className="settings-eyebrow">MÔ HÌNH VÀ API</p>
        <button className="advanced-settings-link" onClick={onAdvanced}><span className="setting-icon setting-icon--mint"><Cpu size={20} /></span><span><strong>Cấu hình AI nâng cao</strong><small>Chọn trợ lý, detector YOLO và host SegFormer</small></span><ArrowRight size={19} /></button>
      </section>
      <div className="privacy-card"><LockKey size={19} /><p><strong>Ảnh và âm thanh chỉ gửi khi bạn bật chức năng tương ứng.</strong><br />Auto Detect gửi khung hình camera tới YOLO host trong lúc theo dõi. Trò chuyện AI chỉ gửi âm thanh khi phiên thoại đang bật; ảnh chỉ gửi nếu bạn bật camera ngữ cảnh. App không lưu ảnh hoặc audio thành tệp. Câu hỏi và câu trả lời dạng chữ được lưu trong Lịch sử; bạn có thể xóa tại đó. {capabilities?.vision_provider === 'ollama' ? 'Mô hình AI chạy cục bộ trên máy tính.' : capabilities?.vision_provider === 'openai' ? 'Nội dung gửi tới OpenAI để xử lý.' : capabilities?.vision_provider === 'cloudflare' ? 'Nội dung gửi tới Workers AI trên Cloudflare để xử lý.' : 'Prototype Auto Detect dùng YOLO host trên máy tính.'} {window.location.hostname.endsWith('trycloudflare.com') && 'Kết nối điện thoại đang đi qua Cloudflare Tunnel.'}</p></div>
      <button className="logout-button" disabled={saving} onClick={onSignOut}><SignOut size={20} />Đăng xuất khỏi hồ sơ</button>
      {saving && <span className="saving-label"><SpinnerGap size={15} />Đang lưu thay đổi</span>}
      <button className="back-to-home" onClick={onBack}>Về trang chính <ArrowRight size={17} /></button>
    </div>
  )
}

function ModelSettingsScreen({ onBack }) {
  const [settings, setSettings] = useState(null)
  const [assistantSettings, setAssistantSettings] = useState(null)
  const [provider, setProvider] = useState('cloudflare')
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [assistantProvider, setAssistantProvider] = useState('cloudflare')
  const [assistantApiKey, setAssistantApiKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState(null)
  const [assistantMessage, setAssistantMessage] = useState(null)
  const [assistantSaving, setAssistantSaving] = useState(false)
  const [assistantTesting, setAssistantTesting] = useState(false)
  const [voiceConfigured, setVoiceConfigured] = useState(false)
  const [voiceTesting, setVoiceTesting] = useState(false)
  const [voiceMessage, setVoiceMessage] = useState(null)
  const [segmentationHealth, setSegmentationHealth] = useState(null)
  const [segmentationSettings, setSegmentationSettings] = useState(null)
  const [segmentationEndpoint, setSegmentationEndpoint] = useState('')
  const [segmentationApiKey, setSegmentationApiKey] = useState('')
  const [segmentationConfigSaving, setSegmentationConfigSaving] = useState(false)
  const [segmentationConfigTesting, setSegmentationConfigTesting] = useState(false)
  const [segmentationConfigMessage, setSegmentationConfigMessage] = useState(null)
  const [segmentationImage, setSegmentationImage] = useState(null)
  const [segmentationResult, setSegmentationResult] = useState(null)
  const [segmentationTesting, setSegmentationTesting] = useState(false)
  const [segmentationMessage, setSegmentationMessage] = useState(null)
  const voiceAudioRef = useRef(null)
  const voiceAudioUrlRef = useRef(null)

  useEffect(() => {
    let active = true
    api('/api/model-settings').then((payload) => {
      if (!active) return
      const value = payload.settings || {}
      setSettings(value)
      setProvider(value.provider || 'cloudflare')
      setEndpoint(value.endpoint_url || '')
    }).catch((error) => {
      if (active) setMessage({ kind: 'error', text: error.message || 'Chưa tải được cấu hình.' })
    }).finally(() => { if (active) setLoading(false) })
    api('/api/assistant-model-settings').then((payload) => {
      if (!active) return
      const value = payload.settings || {}
      setAssistantSettings(value)
      setAssistantProvider(value.provider || 'cloudflare')
    }).catch((error) => {
      if (active) setAssistantMessage({ kind: 'error', text: error.message || 'Chưa tải được cấu hình mô hình trợ lý.' })
    })
    api('/api/status').then((payload) => {
      if (active) setVoiceConfigured(Boolean(payload.voice_tts_ready && payload.voice_tts_provider === 'vieneu_self_hosted'))
    }).catch(() => { if (active) setVoiceConfigured(false) })
    api('/api/segmentation/health').then((payload) => {
      if (active) setSegmentationHealth(payload)
    }).catch(() => { if (active) setSegmentationHealth({ available: false }) })
    api('/api/segmentation-settings').then((payload) => {
      if (!active) return
      const value = payload.settings || {}
      setSegmentationSettings(value)
      setSegmentationEndpoint(value.endpoint_url || '')
    }).catch((error) => {
      if (active) {
        setSegmentationSettings({ editable: false, api_key_configured: false })
        setSegmentationConfigMessage({ kind: 'error', text: error.message || 'Chưa tải được cấu hình SegFormer.' })
      }
    })
    return () => {
      active = false
      voiceAudioRef.current?.pause()
      voiceAudioRef.current = null
      if (voiceAudioUrlRef.current) URL.revokeObjectURL(voiceAudioUrlRef.current)
      voiceAudioUrlRef.current = null
    }
  }, [])

  async function save(event) {
    event.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const payload = await api('/api/model-settings', {
        ...json({ provider, model_name: provider === 'yolo_host' ? 'yolo26n' : 'moondream-cloud', endpoint_url: endpoint, api_key: apiKey }),
        method: 'PUT',
      })
      setSettings(payload.settings)
      setApiKey('')
      setMessage({ kind: 'success', text: 'Đã lưu cấu hình dùng chung. Khóa API được mã hóa ở máy chủ.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error.message || 'Chưa lưu được cấu hình.' })
    } finally { setSaving(false) }
  }

  async function testConnection() {
    setTesting(true)
    setMessage(null)
    try {
      const payload = await api('/api/model-settings', { method: 'POST' })
      setMessage({ kind: payload.ok ? 'success' : 'error', text: payload.ok
        ? payload.sample === 'synthetic'
          ? `Inference mẫu thành công: ${payload.model || 'model'}${payload.device ? ` trên ${payload.device}` : ''}${Number.isFinite(payload.inference_ms) ? ` · ${payload.inference_ms} ms` : ''} · ảnh tổng hợp, ${payload.detection_count ?? 0} vật thể.`
          : `Kết nối được ${payload.model || 'model'} trên ${payload.device || 'máy chủ'}.`
        : (payload.error || 'Model host chưa sẵn sàng.') })
    } catch (error) {
      setMessage({ kind: 'error', text: error.message || 'Không kiểm tra được kết nối.' })
    } finally { setTesting(false) }
  }

  async function saveAssistant(event) {
    event.preventDefault()
    setAssistantSaving(true)
    setAssistantMessage(null)
    try {
      const payload = await api('/api/assistant-model-settings', {
        ...json({
          provider: assistantProvider,
          model_name: assistantProvider === 'openai' ? 'gpt-6-luna' : '@cf/qwen/qwen3.8-27b',
          api_key: assistantApiKey,
        }),
        method: 'PUT',
      })
      setAssistantSettings(payload.settings)
      setAssistantApiKey('')
      setAssistantMessage({ kind: 'success', text: 'Đã lưu mô hình trợ lý. API key được mã hóa ở máy chủ và không gửi lại giao diện.' })
    } catch (error) {
      setAssistantMessage({ kind: 'error', text: error.message || 'Chưa lưu được mô hình trợ lý.' })
    } finally { setAssistantSaving(false) }
  }

  async function testAssistantConnection() {
    setAssistantTesting(true)
    setAssistantMessage(null)
    try {
      const payload = await api('/api/assistant-model-settings', { method: 'POST' })
      setAssistantMessage({ kind: payload.ok ? 'success' : 'error', text: payload.ok
        ? `Kết nối thành công: ${payload.model} · ${payload.provider === 'openai' ? 'OpenAI API' : 'Cloudflare Workers AI'}.`
        : (payload.error || 'Chưa gọi được mô hình trợ lý.') })
    } catch (error) {
      setAssistantMessage({ kind: 'error', text: error.message || 'Không kiểm tra được mô hình trợ lý.' })
    } finally { setAssistantTesting(false) }
  }

  async function saveSegmentationSettings(event) {
    event.preventDefault()
    setSegmentationConfigSaving(true)
    setSegmentationConfigMessage(null)
    try {
      const payload = await api('/api/segmentation-settings', {
        ...json({ endpoint_url: segmentationEndpoint, service_token: segmentationApiKey }),
        method: 'PUT',
      })
      setSegmentationSettings(payload.settings)
      setSegmentationEndpoint(payload.settings?.endpoint_url || '')
      setSegmentationApiKey('')
      setSegmentationConfigMessage({ kind: 'success', text: 'Đã lưu endpoint SegFormer. Token được mã hóa ở máy chủ và không trả lại giao diện.' })
    } catch (error) {
      setSegmentationConfigMessage({ kind: 'error', text: error.message || 'Chưa lưu được cấu hình SegFormer.' })
    } finally { setSegmentationConfigSaving(false) }
  }

  async function testSegmentationConnection() {
    setSegmentationConfigTesting(true)
    setSegmentationConfigMessage(null)
    try {
      const payload = await api('/api/segmentation/health')
      setSegmentationHealth(payload)
      if (!payload.available || payload.model_ready !== true) throw new Error(payload.error || payload.reason || 'SegFormer host chưa sẵn sàng.')
      setSegmentationConfigMessage({ kind: 'success', text: `${payload.model_id || 'SegFormer'} đã sẵn sàng · ${payload.device || 'máy chủ'} · ${payload.class_names?.length || 0} lớp.` })
    } catch (error) {
      setSegmentationConfigMessage({ kind: 'error', text: error.message || 'Không kiểm tra được SegFormer host.' })
    } finally { setSegmentationConfigTesting(false) }
  }

  async function testSegmentation() {
    if (!segmentationImage) return
    setSegmentationTesting(true)
    setSegmentationMessage(null)
    setSegmentationResult(null)
    try {
      const form = new FormData()
      const jpeg = await downscaleAsJpeg(segmentationImage)
      form.append('image', jpeg, jpeg.name)
      const result = await api('/api/segmentation/infer', { method: 'POST', body: form })
      setSegmentationResult(result)
      setSegmentationMessage({ kind: 'success', text: `Đã chạy ${result.model_id.slice(0, 12)}… trên ${segmentationHealth?.device || 'máy chủ'} · ${Math.round(result.inference_ms)} ms · gợi ý: ${result.guidance?.label_vi || 'chưa đủ dữ liệu'}. Model này cũng được dùng trong live guide; kết quả vẫn chỉ là thử nghiệm.` })
    } catch (error) {
      setSegmentationMessage({ kind: 'error', text: error.message || 'Không chạy được SegFormer.' })
    } finally { setSegmentationTesting(false) }
  }

  async function testVieNeuVoice() {
    setVoiceTesting(true)
    setVoiceMessage(null)
    voiceAudioRef.current?.pause()
    if (voiceAudioUrlRef.current) URL.revokeObjectURL(voiceAudioUrlRef.current)
    voiceAudioRef.current = null
    voiceAudioUrlRef.current = null
    try {
      const response = await fetch('/api/voice/synthesize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Xin chào, đây là câu thử giọng đọc tiếng Việt của trợ lý Rõ.' }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error || 'VieNeu-TTS chưa tạo được audio thử.')
      }
      const audioBlob = await response.blob()
      if (!audioBlob.size || !audioBlob.type.startsWith('audio/')) throw new Error('Máy chủ không trả về dữ liệu audio hợp lệ.')
      const audioUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio(audioUrl)
      voiceAudioUrlRef.current = audioUrl
      voiceAudioRef.current = audio
      audio.onended = () => {
        if (voiceAudioRef.current !== audio) return
        URL.revokeObjectURL(audioUrl)
        voiceAudioRef.current = null
        voiceAudioUrlRef.current = null
        setVoiceTesting(false)
        setVoiceMessage({ kind: 'success', text: `Đã phát xong audio VieNeu-TTS (${audioBlob.size.toLocaleString('vi-VN')} byte).` })
      }
      audio.onerror = () => {
        if (voiceAudioRef.current !== audio) return
        URL.revokeObjectURL(audioUrl)
        voiceAudioRef.current = null
        voiceAudioUrlRef.current = null
        setVoiceTesting(false)
        setVoiceMessage({ kind: 'error', text: 'Đã nhận audio nhưng trình duyệt không phát được. Kiểm tra âm lượng và quyền phát media.' })
      }
      await audio.play()
      setVoiceMessage({ kind: 'success', text: `Đã nhận audio VieNeu-TTS (${audioBlob.size.toLocaleString('vi-VN')} byte), đang phát thử.` })
    } catch (error) {
      if (voiceAudioUrlRef.current) URL.revokeObjectURL(voiceAudioUrlRef.current)
      voiceAudioRef.current = null
      voiceAudioUrlRef.current = null
      setVoiceTesting(false)
      setVoiceMessage({ kind: 'error', text: error.message || 'Không kiểm tra được VieNeu-TTS.' })
    }
  }

  if (loading) return <div className="ai-settings-screen page-pad"><header className="subpage-top"><button className="back-button" onClick={onBack}><ArrowLeft size={21} />Cài đặt</button></header><p role="status">Đang tải cài đặt model…</p></div>
  if (settings && !settings.editable) return <div className="ai-settings-screen page-pad"><header className="subpage-top"><button className="back-button" onClick={onBack}><ArrowLeft size={21} />Cài đặt</button></header><h1>Cấu hình AI nâng cao</h1><div className="setup-note"><LockKey size={18} /><p>Cấu hình model dùng chung chỉ do chủ app thay đổi. Hiện app dùng {settings.provider === 'yolo_host' ? 'YOLO host' : 'Cloudflare'} · {settings.model_name}.</p></div><button className="back-to-home" onClick={onBack}>Quay lại</button></div>

  return (
    <div className="ai-settings-screen page-pad">
      <header className="subpage-top"><button className="back-button" onClick={onBack}><ArrowLeft size={21} />Cài đặt</button><span className="live-state live-state--on"><span />AI</span></header>
      <div className="ai-settings-heading"><p className="eyebrow">ĐIỀU KHIỂN MÁY CHỦ</p><h1>Cấu hình model<br /><em>và API.</em></h1><p>Chọn mô hình trò chuyện, detector ảnh và dịch vụ phân đoạn. API key chỉ gửi tới backend; cấu hình model dùng chung cho tài khoản ứng dụng.</p></div>
      <form className="model-settings-form" onSubmit={saveAssistant}>
        <div className="model-choice-card"><span className="model-choice-icon"><Sparkle size={21} /></span><span><strong>Mô hình trợ lý · hỏi đáp và xem ảnh</strong><small>Độc lập với detector camera và model trên ESP32.</small></span><span className="model-state-chip">LLM</span></div>
        <label className="field-label">Nhà cung cấp
          <select value={assistantProvider} onChange={(event) => setAssistantProvider(event.target.value)} disabled={assistantSaving || assistantTesting}>
            <option value="openai">OpenAI · GPT-6 Luna</option>
            <option value="cloudflare">Cloudflare · Qwen 3.8 27B</option>
          </select>
        </label>
        <div className="model-choice-card"><span className="model-choice-icon"><Cpu size={21} /></span><span><strong>{assistantProvider === 'openai' ? 'GPT-6 Luna · gpt-6-luna' : 'Qwen 3.8 27B · @cf/qwen/qwen3.8-27b'}</strong><small>{assistantProvider === 'openai' ? 'Vision + văn bản qua OpenAI API; cần API key có quyền gọi model.' : 'Chạy qua Workers AI binding của Cloudflare.'}</small></span><span className={`model-state-chip ${assistantSettings?.api_key_configured || assistantProvider === 'cloudflare' ? '' : 'model-state-chip--pending'}`}>{assistantProvider === 'openai' ? assistantSettings?.api_key_configured ? 'ĐÃ CẤU HÌNH' : 'CẦN API KEY' : 'CLOUD'}</span></div>
        {assistantProvider === 'openai' && <label className="field-label">OpenAI API key<input type="password" autoComplete="new-password" value={assistantApiKey} onChange={(event) => setAssistantApiKey(event.target.value)} placeholder={assistantSettings?.api_key_configured ? 'Đã có key · để trống nếu không đổi' : 'Dán API key OpenAI của bạn'} /></label>}
        <div className="setup-note"><Info size={18} /><p>Key chỉ được gửi tới Worker qua kết nối bảo mật, mã hóa trước khi lưu vào D1 và không trả lại app. Nút kiểm tra gửi một câu văn bản ngắn, không gửi ảnh camera. Chuyển sang OpenAI cần key và quyền API; detector YOLO trên server không đổi.</p></div>
        {assistantMessage && <p className={`model-settings-message model-settings-message--${assistantMessage.kind}`} role={assistantMessage.kind === 'error' ? 'alert' : 'status'}>{assistantMessage.kind === 'success' ? <CheckCircle size={18} /> : <WarningCircle size={18} />}{assistantMessage.text}</p>}
        <div className="model-settings-actions"><button className="action-button action-button--dark" type="submit" disabled={assistantSaving || assistantTesting || !settings?.editable}>{assistantSaving ? <SpinnerGap size={19} /> : <LockKey size={19} />}{assistantSaving ? 'Đang lưu…' : 'Lưu mô hình trợ lý'}</button><button className="action-button model-test-button" type="button" onClick={testAssistantConnection} disabled={assistantSaving || assistantTesting || !settings?.editable || !assistantSettings?.api_key_configured && assistantProvider === 'openai'}>{assistantTesting ? <SpinnerGap size={19} /> : <WifiHigh size={19} />}{assistantTesting ? 'Đang kiểm tra…' : 'Kiểm tra mô hình'}</button></div>
      </form>
      <form className="model-settings-form" onSubmit={save}>
        <label className="field-label">Nơi chạy model
          <select value={provider} onChange={(event) => setProvider(event.target.value)} disabled={saving || testing}>
            <option value="cloudflare">Cloudflare · Moondream</option>
            <option value="yolo_host">Máy của tôi · YOLO26n</option>
          </select>
        </label>
        {provider === 'yolo_host' && <>
          <div className="model-choice-card"><span className="model-choice-icon"><Cpu size={21} /></span><span><strong>YOLO26n · pretrained COCO</strong><small>Host tải weights và warm-up model khi khởi động.</small></span><span className="model-state-chip">MẪU</span></div>
          <label className="field-label">Cloudflare Tunnel URL<input required type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck="false" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://ten-ngau-nhien.trycloudflare.com" /></label>
          <label className="field-label">API key của YOLO host<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.api_key_configured ? 'Đã có key · để trống nếu không đổi' : 'Dán RO_YOLO_HOST_TOKEN trong yolo_host/.env'} /></label>
          <div className="setup-note"><Info size={18} /><p>Trên máy tính, chạy <code>start_yolo_host.ps1</code>, sau đó <code>start_yolo_tunnel.ps1</code>. Giữ cả hai cửa sổ mở. Dán URL tunnel và key vào đây. Máy tính phải bật, có Internet và không ngủ.</p></div>
        </>}
        {message && <p className={`model-settings-message model-settings-message--${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.kind === 'success' ? <CheckCircle size={18} /> : <WarningCircle size={18} />}{message.text}</p>}
        <div className="model-settings-actions"><button className="action-button action-button--dark" type="submit" disabled={saving || testing || !settings?.editable}>{saving ? <SpinnerGap size={19} /> : <LockKey size={19} />}{saving ? 'Đang lưu…' : 'Lưu cấu hình'}</button><button className="action-button model-test-button" type="button" onClick={testConnection} disabled={saving || testing || !settings?.editable || !settings?.api_key_configured}>{testing ? <SpinnerGap size={19} /> : <WifiHigh size={19} />}{testing ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button></div>
      </form>
      {segmentationSettings?.editable && <form className="model-settings-form segmentation-host-settings" onSubmit={saveSegmentationSettings}>
        <div className="model-choice-card"><span className="model-choice-icon"><Eye size={21} /></span><span><strong>SegFormer-B2 · phân đoạn lối đi</strong><small>Model chạy trên máy tính của bạn; app chuyển tiếp ảnh qua backend đã đăng nhập.</small></span><span className={`model-state-chip ${segmentationSettings?.token_configured ? '' : 'model-state-chip--pending'}`}>{segmentationSettings?.token_configured ? 'ĐÃ CẤU HÌNH' : 'CHƯA NỐI HOST'}</span></div>
        <label className="field-label">Endpoint HTTPS của SegFormer host<input type="url" inputMode="url" autoComplete="url" value={segmentationEndpoint} onChange={(event) => setSegmentationEndpoint(event.target.value)} placeholder="https://<tunnel>.trycloudflare.com" disabled={segmentationConfigSaving || segmentationConfigTesting} /></label>
        <label className="field-label">Token dịch vụ SegFormer<input type="password" autoComplete="new-password" value={segmentationApiKey} onChange={(event) => setSegmentationApiKey(event.target.value)} placeholder={segmentationSettings?.token_configured ? 'Đã có token · để trống nếu không đổi' : 'Dán RO_SEGMENTATION_TOKEN'} disabled={segmentationConfigSaving || segmentationConfigTesting} /></label>
        <p className="voice-test-hint">Để máy tính chạy start_sanpo_navigation_server.ps1 và giữ tunnel hoạt động. Tunnel chỉ mở đường tới model host; Worker xác thực token ở phía máy chủ. Ảnh camera không được lưu thành tệp.</p>
        {segmentationConfigMessage && <p className={`model-settings-message model-settings-message--${segmentationConfigMessage.kind}`} role={segmentationConfigMessage.kind === 'error' ? 'alert' : 'status'}>{segmentationConfigMessage.kind === 'success' ? <CheckCircle size={18} /> : <WarningCircle size={18} />}{segmentationConfigMessage.text}</p>}
        <div className="model-settings-actions"><button className="action-button action-button--dark" type="submit" disabled={segmentationConfigSaving || segmentationConfigTesting || !settings?.editable}>{segmentationConfigSaving ? <SpinnerGap size={19} /> : <LockKey size={19} />}{segmentationConfigSaving ? 'Đang lưu…' : 'Lưu SegFormer host'}</button><button className="action-button model-test-button" type="button" onClick={() => void testSegmentationConnection()} disabled={segmentationConfigSaving || segmentationConfigTesting || !settings?.editable || !segmentationSettings?.token_configured}>{segmentationConfigTesting ? <SpinnerGap size={19} /> : <WifiHigh size={19} />}{segmentationConfigTesting ? 'Đang kiểm tra…' : 'Kiểm tra host'}</button></div>
      </form>}
      <section className="voice-test-card segmentation-test-card" aria-labelledby="segmentation-test-title">
        <div><strong id="segmentation-test-title">SegFormer-B2 SANPO trên máy chủ</strong><p>{segmentationHealth?.available ? `Đã nối ${segmentationHealth.device || 'máy chủ'} · ${segmentationHealth.class_names?.length || 0} lớp · trạng thái ${segmentationHealth.calibration_status}.` : 'SegFormer host chưa chạy hoặc chưa kết nối.'} Model này trả mask phân đoạn và gợi ý vùng trái/giữa/phải. Chọn ảnh từ điện thoại hoặc máy tính; app tự xoay ảnh và thu cạnh dài tối đa 1.280 px trước khi gửi. Ảnh chỉ xử lý tạm thời, máy chủ không lưu. Gợi ý chưa hiệu chuẩn với camera/đường đi thực tế.</p></div>
        <label className="field-label">Ảnh để xem mask<input type="file" accept="image/*" onChange={(event) => { setSegmentationImage(event.target.files?.[0] || null); setSegmentationResult(null); setSegmentationMessage(null) }} /></label>
        <button className="action-button model-test-button" type="button" onClick={() => void testSegmentation()} disabled={!settings?.editable || !segmentationHealth?.available || !segmentationImage || segmentationTesting}>
          {segmentationTesting ? <SpinnerGap size={19} /> : <FileImage size={19} />}{segmentationTesting ? 'Đang phân đoạn…' : 'Chạy SegFormer thử'}
        </button>
        {segmentationMessage && <p className={`model-settings-message model-settings-message--${segmentationMessage.kind}`} role={segmentationMessage.kind === 'error' ? 'alert' : 'status'}>{segmentationMessage.kind === 'success' ? <CheckCircle size={18} /> : <WarningCircle size={18} />}{segmentationMessage.text}</p>}
        {segmentationResult && <div className="segmentation-result-preview"><img src={`data:image/png;base64,${segmentationResult.mask_png_base64}`} alt="Mặt nạ phân đoạn SegFormer" /><ul>{segmentationResult.classes_present.map((item) => <li key={item.class_id}>{item.class_name}: {(item.area_ratio * 100).toFixed(1)}% · confidence {item.mean_confidence.toFixed(2)}</li>)}</ul></div>}
      </section>
      <section className="voice-test-card" aria-labelledby="voice-test-title">
        <div><strong id="voice-test-title">Kiểm tra giọng đọc VieNeu-TTS</strong><p>Gửi một câu thử ngắn tới máy chủ VieNeu-TTS tự host qua Cloudflare Worker rồi phát audio nhận được. Thông tin bảo vệ endpoint chỉ lưu ở Worker secrets; audio không được lưu thành tệp.</p></div>
        <button className="action-button model-test-button" type="button" onClick={() => void testVieNeuVoice()} disabled={voiceTesting || !settings?.editable || !voiceConfigured}>
          {voiceTesting ? <SpinnerGap size={19} className="voice-spin" /> : <SpeakerHigh size={19} />}{voiceTesting ? 'Đang tạo / phát audio…' : 'Thử giọng VieNeu-TTS'}
        </button>
        {!voiceConfigured && <p className="voice-test-hint">VieNeu-TTS tự host chưa được nối hoặc chưa sẵn sàng.</p>}
        {voiceMessage && <p className={`model-settings-message model-settings-message--${voiceMessage.kind}`} role={voiceMessage.kind === 'error' ? 'alert' : 'status'}>{voiceMessage.kind === 'success' ? <CheckCircle size={18} /> : <WarningCircle size={18} />}{voiceMessage.text}</p>}
      </section>
      <div className="license-note"><strong>Model mẫu và giấy phép</strong><p>YOLO26 là model Ultralytics mới nhất đã xác minh. Model mặc định theo AGPL‑3.0; nếu mở API công khai mà không công bố dự án theo giấy phép này, cần kiểm tra lựa chọn Enterprise trước khi cung cấp rộng rãi.</p><p>Nút kiểm tra gửi một ảnh tổng hợp rất nhỏ để xác nhận model inference và không dùng ảnh camera của bạn.</p><a href="https://www.ultralytics.com/license" target="_blank" rel="noreferrer">Đọc điều khoản Ultralytics <ArrowRight size={15} /></a></div>
      <p className="privacy-card"><LockKey size={19} /><span>Ảnh gửi lên model host đi qua Cloudflare Worker và Tunnel tới máy của bạn; server mẫu không lưu ảnh. API key được mã hóa trong D1 và không trả lại giao diện.</span></p>
    </div>
  )
}

function ToggleRow({ Icon, tone, title, description, checked, disabled = false, onChange }) {
  return <div className="setting-row"><span className={`setting-icon setting-icon--${tone}`}><Icon size={20} /></span><div className="setting-copy"><strong>{title}</strong><span>{description}</span></div><button type="button" role="switch" aria-checked={checked} aria-label={title} disabled={disabled} className={`switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}><span /></button></div>
}

function StatusRow({ title, detail, connected }) {
  return <div className="status-row"><span className={`status-ring ${connected ? 'is-connected' : ''}`}>{connected ? <Check size={13} weight="bold" /> : <span />}</span><div><strong>{title}</strong><span>{detail}</span></div></div>
}

function ConfirmDialog({ onCancel, onConfirm }) {
  return <div className="dialog-scrim dialog-scrim--enter" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}><div role="dialog" aria-modal="true" aria-labelledby="clear-title" className="confirm-dialog confirm-dialog--enter"><span className="dialog-icon"><Trash size={25} /></span><button className="dialog-close" aria-label="Đóng" onClick={onCancel}><X size={20} /></button><h2 id="clear-title">Xóa những lần đã xem?</h2><p>Câu hỏi và câu trả lời bằng chữ sẽ bị xóa khỏi hồ sơ này.</p><div className="dialog-actions"><button className="dialog-cancel" onClick={onCancel}>Giữ lại</button><button className="dialog-delete" onClick={onConfirm}>Xóa lịch sử</button></div></div></div>
}

export default App
