import CoreVideo
import Foundation

struct DepthSnapshot: Sendable {
    let width: Int
    let height: Int
    let values: [Float]
    let confidence: [UInt8]

    static func copy(depthMap: CVPixelBuffer, confidenceMap: CVPixelBuffer?) -> DepthSnapshot? {
        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) }

        let width = CVPixelBufferGetWidth(depthMap)
        let height = CVPixelBufferGetHeight(depthMap)
        guard width > 0, height > 0, let base = CVPixelBufferGetBaseAddress(depthMap) else {
            return nil
        }

        let bytesPerRow = CVPixelBufferGetBytesPerRow(depthMap)
        var values = [Float](repeating: 0, count: width * height)
        for rowIndex in 0..<height {
            let row = base
                .advanced(by: rowIndex * bytesPerRow)
                .assumingMemoryBound(to: Float32.self)
            let destinationOffset = rowIndex * width
            for columnIndex in 0..<width {
                values[destinationOffset + columnIndex] = row[columnIndex]
            }
        }

        var confidence: [UInt8] = []
        if let confidenceMap,
           CVPixelBufferGetWidth(confidenceMap) == width,
           CVPixelBufferGetHeight(confidenceMap) == height {
            CVPixelBufferLockBaseAddress(confidenceMap, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly) }
            if let confidenceBase = CVPixelBufferGetBaseAddress(confidenceMap) {
                let confidenceBytesPerRow = CVPixelBufferGetBytesPerRow(confidenceMap)
                confidence.reserveCapacity(width * height)
                for rowIndex in 0..<height {
                    let row = confidenceBase
                        .advanced(by: rowIndex * confidenceBytesPerRow)
                        .assumingMemoryBound(to: UInt8.self)
                    confidence.append(contentsOf: UnsafeBufferPointer(start: row, count: width))
                }
            }
        }

        return DepthSnapshot(width: width, height: height, values: values, confidence: confidence)
    }

    func centerDistance() -> Double? {
        sample(x: 0.5, y: 0.5)
    }

    func distance(normalizedBox box: [Double]) -> Double? {
        guard box.count >= 4, box.prefix(4).allSatisfy({ $0.isFinite }) else { return nil }
        let left = min(1, max(0, box[0]))
        let top = min(1, max(0, box[1]))
        let right = min(1, max(0, box[2]))
        let bottom = min(1, max(0, box[3]))
        guard right > left, bottom > top else { return nil }
        let x = (left + right) / 2
        let y = (top + bottom) / 2
        return sample(x: x, y: y)
    }

    private func sample(x: Double, y: Double) -> Double? {
        guard width > 0, height > 0, values.count == width * height else { return nil }
        let normalizedX = min(1, max(0, x))
        let normalizedY = min(1, max(0, y))

        // ARKit's rear-camera buffers are landscape-oriented while this app
        // uploads a portrait JPEG. Rotate portrait coordinates back to the map.
        let pixelX: Int
        let pixelY: Int
        if width > height {
            pixelX = Int(normalizedY * Double(width - 1))
            pixelY = Int((1 - normalizedX) * Double(height - 1))
        } else {
            pixelX = Int(normalizedX * Double(width - 1))
            pixelY = Int(normalizedY * Double(height - 1))
        }

        var nearby: [Float] = []
        for yOffset in -1...1 {
            for xOffset in -1...1 {
                let xIndex = pixelX + xOffset
                let yIndex = pixelY + yOffset
                guard xIndex >= 0, xIndex < width, yIndex >= 0, yIndex < height else { continue }
                let index = yIndex * width + xIndex
                if !confidence.isEmpty, confidence[index] < 1 { continue }
                let value = values[index]
                if value.isFinite, value >= 0.15, value <= 10 {
                    nearby.append(value)
                }
            }
        }
        guard !nearby.isEmpty else { return nil }
        nearby.sort()
        return Double(nearby[nearby.count / 2])
    }
}
