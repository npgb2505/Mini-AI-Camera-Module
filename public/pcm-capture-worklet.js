class RoPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.step = sampleRate / 16000
    this.position = 0
    this.pending = []
    this.batchSize = 1600
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]
    if (output) {
      for (const channel of output) channel.fill(0)
    }
    if (!input?.length) return true

    while (this.position < input.length - 1) {
      const lower = Math.floor(this.position)
      const fraction = this.position - lower
      const sample = input[lower] * (1 - fraction) + input[lower + 1] * fraction
      const clipped = Math.max(-1, Math.min(1, sample))
      this.pending.push(clipped < 0 ? clipped * 32768 : clipped * 32767)
      this.position += this.step
    }
    this.position -= input.length

    while (this.pending.length >= this.batchSize) {
      const pcm = new Int16Array(this.batchSize)
      for (let index = 0; index < this.batchSize; index += 1) pcm[index] = this.pending[index]
      this.pending.splice(0, this.batchSize)
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }
    return true
  }
}

registerProcessor('ro-pcm-capture', RoPcmCaptureProcessor)
