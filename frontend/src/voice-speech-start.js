export class VoiceSpeechStartGate {
  constructor(confirmFrames = 4) {
    this.confirmFrames = Math.max(1, Math.floor(confirmFrames))
    this.candidateFrames = 0
    this.startedAt = 0
    this.confirmed = false
  }

  reset() {
    this.candidateFrames = 0
    this.startedAt = 0
    this.confirmed = false
  }

  process(speechActive, recorderActive, nowMs) {
    if (this.confirmed) return { action: 'confirmed', startedAt: this.startedAt }
    if (!speechActive) {
      const cancel = recorderActive && this.candidateFrames > 0
      this.reset()
      return { action: cancel ? 'cancel' : 'none', startedAt: 0 }
    }

    if (!this.candidateFrames) {
      this.candidateFrames = 1
      this.startedAt = nowMs
      return { action: recorderActive ? 'none' : 'start', startedAt: this.startedAt }
    }

    this.candidateFrames += 1
    if (this.candidateFrames < this.confirmFrames) return { action: 'none', startedAt: this.startedAt }
    this.confirmed = true
    return { action: 'confirm', startedAt: this.startedAt }
  }
}
