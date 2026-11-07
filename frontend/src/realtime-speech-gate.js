import { REALTIME_SILENCE_FRAME } from './voice-audio-keepalive.js'

const HISTORY_FRAMES = 20
// The worklet emits 100 ms PCM chunks and speech confirmation needs 250 ms.
// Keep at least 400 ms so a turn is not committed without its first syllable.
const PREROLL_FRAMES = 4
const MIN_START_RMS = 0.012
const START_NOISE_RATIO = 2.1
const END_NOISE_RATIO = 1.45
const SPEECH_CONFIRM_MS = 250
const SILENCE_END_MS = 600
const MAX_ACTIVE_UTTERANCE_MS = 15000
const HIGH_PASS_ALPHA = 0.954

export class RealtimeSpeechGate {
  constructor() {
    this.noiseFloor = 0.004
    this.noiseHistory = []
    this.preRoll = []
    this.active = false
    this.candidateMs = 0
    this.silenceMs = 0
    this.activeMs = 0
    this.previousInput = 0
    this.previousOutput = 0
  }

  resetTurn() {
    this.preRoll = []
    this.active = false
    this.candidateMs = 0
    this.silenceMs = 0
    this.activeMs = 0
  }

  updateNoiseFloor(rms) {
    this.noiseHistory.push(rms)
    if (this.noiseHistory.length > HISTORY_FRAMES) this.noiseHistory.shift()
    if (this.noiseHistory.length < 8) return
    const ordered = [...this.noiseHistory].sort((a, b) => a - b)
    const percentile20 = ordered[Math.floor((ordered.length - 1) * 0.2)]
    this.noiseFloor += (percentile20 - this.noiseFloor) * 0.16
    this.noiseFloor = Math.max(0.001, Math.min(0.12, this.noiseFloor))
  }

  process(frame) {
    const samples = new Int16Array(frame)
    let sum = 0
    for (const sample of samples) {
      const input = sample / 32768
      const output = HIGH_PASS_ALPHA * (this.previousOutput + input - this.previousInput)
      this.previousInput = input
      this.previousOutput = output
      sum += output * output
    }
    const rms = samples.length ? Math.sqrt(sum / samples.length) : 0
    const durationMs = samples.length / 16
    // Continue adapting to slow changes in room/fan noise after speech starts.
    // Otherwise a noise change mid-utterance can hold the gate open forever.
    this.updateNoiseFloor(rms)

    if (!this.active) {
      this.preRoll.push(frame.slice(0))
      if (this.preRoll.length > PREROLL_FRAMES) this.preRoll.shift()
      const startThreshold = Math.max(MIN_START_RMS, this.noiseFloor * START_NOISE_RATIO)
      this.candidateMs = rms >= startThreshold ? this.candidateMs + durationMs : 0
      if (this.candidateMs < SPEECH_CONFIRM_MS) {
        return { frames: [REALTIME_SILENCE_FRAME], rms, speechActive: false }
      }
      this.active = true
      this.silenceMs = 0
      this.activeMs = 0
      const frames = this.preRoll
      this.preRoll = []
      return { frames, rms, speechActive: true }
    }

    const endThreshold = Math.max(0.006, this.noiseFloor * END_NOISE_RATIO)
    this.silenceMs = rms >= endThreshold ? 0 : this.silenceMs + durationMs
    this.activeMs += durationMs
    const frames = [frame]
    if (this.silenceMs >= SILENCE_END_MS || this.activeMs >= MAX_ACTIVE_UTTERANCE_MS) this.resetTurn()
    return { frames, rms, speechActive: this.active }
  }
}
