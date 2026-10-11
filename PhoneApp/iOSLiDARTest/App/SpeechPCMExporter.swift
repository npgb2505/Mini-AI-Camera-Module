import AVFoundation
import Foundation

enum SpeechPCMExporter {
    static let sampleRateHz = 16_000.0
    static let maximumBytes = 256_000
    private static let timeoutSeconds: TimeInterval = 20

    static func makePCM16LE(text: String) async throws -> Data {
        guard let voice = AVSpeechSynthesisVoice(language: "vi-VN") else {
            throw ExportError.unavailableVoice
        }
        let synthesizer = AVSpeechSynthesizer()
        synthesizer.usesApplicationAudioSession = false
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice

        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Data, Error>) in
            let state = ExportState(synthesizer: synthesizer,
                                    continuation: continuation)
            let timeout = DispatchWorkItem {
                state.finish(.failure(ExportError.timedOut))
            }
            state.setTimeout(timeout)
            DispatchQueue.global().asyncAfter(
                deadline: .now() + timeoutSeconds,
                execute: timeout
            )
            synthesizer.write(utterance) { buffer in
                state.consume(buffer)
            }
        }
    }

    private enum ExportError: LocalizedError {
        case unavailableVoice
        case unavailableFormat
        case conversionFailed
        case tooLong
        case timedOut

        var errorDescription: String? {
            switch self {
            case .unavailableVoice:
                return "Trên iPhone chưa có giọng đọc tiếng Việt để tạo audio."
            case .unavailableFormat:
                return "iOS không cung cấp định dạng âm thanh TTS phù hợp."
            case .conversionFailed:
                return "Không chuyển được giọng đọc sang PCM16LE 16 kHz mono."
            case .tooLong:
                return "Câu trả lời dài hơn giới hạn phát loa ESP32 là 8 giây."
            case .timedOut:
                return "iOS không hoàn tất tạo audio trong thời gian cho phép."
            }
        }
    }

    private final class ExportState {
        private let lock = NSLock()
        private let synthesizer: AVSpeechSynthesizer
        private var continuation: CheckedContinuation<Data, Error>?
        private var timeout: DispatchWorkItem?
        private var converter: AVAudioConverter?
        private var outputFormat: AVAudioFormat?
        private var pcm16le = Data()
        private var finished = false

        init(synthesizer: AVSpeechSynthesizer,
             continuation: CheckedContinuation<Data, Error>) {
            self.synthesizer = synthesizer
            self.continuation = continuation
            pcm16le.reserveCapacity(maximumBytes)
        }

        func setTimeout(_ timeout: DispatchWorkItem) {
            lock.lock()
            self.timeout = timeout
            lock.unlock()
        }

        func consume(_ buffer: AVAudioBuffer) {
            var result: Result<Data, Error>?
            lock.lock()
            guard !finished else {
                lock.unlock()
                return
            }
            do {
                guard let input = buffer as? AVAudioPCMBuffer else {
                    throw ExportError.unavailableFormat
                }
                if input.frameLength == 0 {
                    try finishConversion()
                    result = .success(pcm16le)
                } else {
                    try appendConverted(input)
                }
            } catch {
                result = .failure(error)
            }
            lock.unlock()
            if let result {
                finish(result)
            }
        }

        private func appendConverted(_ input: AVAudioPCMBuffer) throws {
            if converter == nil {
                guard input.format.sampleRate > 0,
                      input.format.channelCount > 0,
                      let output = AVAudioFormat(
                        commonFormat: .pcmFormatInt16,
                        sampleRate: SpeechPCMExporter.sampleRateHz,
                        channels: 1,
                        interleaved: true
                      ),
                      let audioConverter = AVAudioConverter(
                        from: input.format,
                        to: output
                      ) else {
                    throw ExportError.unavailableFormat
                }
                outputFormat = output
                converter = audioConverter
            }
            guard let converter, let outputFormat,
                  converter.inputFormat.sampleRate == input.format.sampleRate,
                  converter.inputFormat.channelCount == input.format.channelCount,
                  converter.inputFormat.commonFormat == input.format.commonFormat,
                  converter.inputFormat.isInterleaved == input.format.isInterleaved else {
                throw ExportError.unavailableFormat
            }

            let ratio = outputFormat.sampleRate / input.format.sampleRate
            let capacity = AVAudioFrameCount(
                ceil(Double(input.frameLength) * ratio) + 128
            )
            guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat,
                                                frameCapacity: capacity) else {
                throw ExportError.conversionFailed
            }
            var suppliedInput = false
            var conversionError: NSError?
            let status = converter.convert(to: output, error: &conversionError) {
                _, inputStatus in
                if !suppliedInput {
                    suppliedInput = true
                    inputStatus.pointee = .haveData
                    return input
                }
                inputStatus.pointee = .noDataNow
                return nil
            }
            if conversionError != nil || status == .error {
                throw ExportError.conversionFailed
            }
            try appendLittleEndianSamples(from: output)
        }

        private func finishConversion() throws {
            guard let converter, let outputFormat else { return }
            for _ in 0..<8 {
                guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat,
                                                    frameCapacity: 4096) else {
                    throw ExportError.conversionFailed
                }
                var conversionError: NSError?
                let status = converter.convert(to: output, error: &conversionError) {
                    _, inputStatus in
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                if conversionError != nil || status == .error {
                    throw ExportError.conversionFailed
                }
                try appendLittleEndianSamples(from: output)
                if status == .endOfStream || output.frameLength == 0 {
                    return
                }
            }
            throw ExportError.conversionFailed
        }

        private func appendLittleEndianSamples(from buffer: AVAudioPCMBuffer) throws {
            guard buffer.format.commonFormat == .pcmFormatInt16,
                  buffer.format.channelCount == 1,
                  let channels = buffer.int16ChannelData else {
                throw ExportError.conversionFailed
            }
            let frameCount = Int(buffer.frameLength)
            let newByteCount = frameCount * MemoryLayout<UInt16>.size
            guard pcm16le.count + newByteCount <= SpeechPCMExporter.maximumBytes else {
                throw ExportError.tooLong
            }
            let samples = channels[0]
            for frame in 0..<frameCount {
                let littleEndian = UInt16(bitPattern: samples[frame]).littleEndian
                pcm16le.append(UInt8(truncatingIfNeeded: littleEndian))
                pcm16le.append(UInt8(truncatingIfNeeded: littleEndian >> 8))
            }
        }

        func finish(_ result: Result<Data, Error>) {
            lock.lock()
            guard !finished else {
                lock.unlock()
                return
            }
            finished = true
            let continuation = self.continuation
            self.continuation = nil
            let timeout = self.timeout
            self.timeout = nil
            lock.unlock()

            timeout?.cancel()
            if case .failure = result {
                synthesizer.stopSpeaking(at: .immediate)
            }
            continuation?.resume(with: result)
        }
    }
}
