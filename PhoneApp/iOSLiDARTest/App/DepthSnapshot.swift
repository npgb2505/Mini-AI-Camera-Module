import CoreVideo
import Foundation

struct DepthSnapshot: Sendable {
    let width: Int
    let height: Int
    let values: [Float]
    let confidence: [UInt8]

    static func copy(depthMap: CVPixelBuffer, confidenceMap: CVPixelBuffer?) -> DepthSnapshot? {
        guard CVPixelBufferGetPixelFormatType(depthMap) == kCVPixelFormatType_DepthFloat32,
              CVPixelBufferLockBaseAddress(depthMap, .readOnly) == kCVReturnSuccess else {
            return nil
        }
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
        if let confidenceMap {
            guard CVPixelBufferGetPixelFormatType(confidenceMap) == kCVPixelFormatType_OneComponent8,
                  CVPixelBufferGetWidth(confidenceMap) == width,
                  CVPixelBufferGetHeight(confidenceMap) == height,
                  CVPixelBufferLockBaseAddress(confidenceMap, .readOnly) == kCVReturnSuccess else {
                return nil
            }
            defer { CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly) }
            guard let confidenceBase = CVPixelBufferGetBaseAddress(confidenceMap) else {
                return nil
            }
            let confidenceBytesPerRow = CVPixelBufferGetBytesPerRow(confidenceMap)
            confidence.reserveCapacity(width * height)
            for rowIndex in 0..<height {
                let row = confidenceBase
                    .advanced(by: rowIndex * confidenceBytesPerRow)
                    .assumingMemoryBound(to: UInt8.self)
                confidence.append(contentsOf: UnsafeBufferPointer(start: row, count: width))
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

        // YOLO boxes are in the portrait JPEG's coordinates. ARKit's rear
        // camera depth map is commonly landscape-oriented, so rotate the
        // rectangle back before sampling its center area.
        let depthLeft: Double
        let depthTop: Double
        let depthRight: Double
        let depthBottom: Double
        if width > height {
            depthLeft = top
            depthTop = 1 - right
            depthRight = bottom
            depthBottom = 1 - left
        } else {
            depthLeft = left
            depthTop = top
            depthRight = right
            depthBottom = bottom
        }

        // Avoid box edges, which often contain background depth. The inner
        // half of the detection box is more likely to belong to the object.
        let insetX = (depthRight - depthLeft) * 0.25
        let insetY = (depthBottom - depthTop) * 0.25
        guard let xRange = pixelRange(
                  minimum: depthLeft + insetX,
                  maximum: depthRight - insetX,
                  count: width
              ),
              let yRange = pixelRange(
                  minimum: depthTop + insetY,
                  maximum: depthBottom - insetY,
                  count: height
              ) else {
            return nil
        }
        return medianDepth(xRange: xRange, yRange: yRange)
    }

    private func sample(x: Double, y: Double) -> Double? {
        guard width > 0,
              height > 0,
              values.count == width * height,
              confidence.isEmpty || confidence.count == values.count else {
            return nil
        }
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

        let xRange = max(0, pixelX - 1)...min(width - 1, pixelX + 1)
        let yRange = max(0, pixelY - 1)...min(height - 1, pixelY + 1)
        return medianDepth(xRange: xRange, yRange: yRange)
    }

    private func pixelRange(minimum: Double, maximum: Double, count: Int) -> ClosedRange<Int>? {
        guard count > 0, minimum.isFinite, maximum.isFinite, maximum >= minimum else { return nil }
        let lastIndex = Double(count - 1)
        let lower = min(count - 1, max(0, Int(floor(minimum * lastIndex))))
        let upper = min(count - 1, max(0, Int(ceil(maximum * lastIndex))))
        guard upper >= lower else { return nil }
        return lower...upper
    }

    private func medianDepth(xRange: ClosedRange<Int>, yRange: ClosedRange<Int>) -> Double? {
        guard width > 0,
              height > 0,
              values.count == width * height,
              confidence.isEmpty || confidence.count == values.count else {
            return nil
        }

        var nearby: [Float] = []
        for yIndex in yRange {
            for xIndex in xRange {
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
        let middle = nearby.count / 2
        if nearby.count.isMultiple(of: 2) {
            return (Double(nearby[middle - 1]) + Double(nearby[middle])) / 2
        }
        return Double(nearby[middle])
    }
}
