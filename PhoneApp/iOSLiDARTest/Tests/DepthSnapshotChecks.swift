import Foundation
import CoreVideo

@main
enum DepthSnapshotChecks {
    static func main() {
        testLandscapeDepthMapUsesPortraitDetectionCoordinates()
        testPortraitDepthMapUsesDirectCoordinates()
        testBackendNormalizedYOLOBoxMapsToPortraitDepth()
        testMalformedNormalizedBoxFailsClosed()
        testCenterDistanceUsesMedian()
        testLowConfidenceSamplesAreIgnored()
        testCoreVideoDepthAndConfidenceBuffersAreCopied()
        testInvalidDepthAndMalformedConfidenceFailClosed()
        testInvalidDetectionBoxesAreRejected()
        print("DepthSnapshot checks passed: 9 cases")
    }

    private static func testLandscapeDepthMapUsesPortraitDetectionCoordinates() {
        let width = 8
        let height = 6
        var values = Array(repeating: Float(4), count: width * height)
        fillNeighborhood(value: 1.25, centerX: 5, centerY: 3, width: width, in: &values)
        let snapshot = DepthSnapshot(width: width, height: height, values: values, confidence: [])

        assertDistance(
            snapshot.distance(normalizedBox: [0.15, 0.65, 0.35, 0.85]),
            equals: 1.25,
            named: "landscape portrait-coordinate rotation"
        )
    }

    private static func testPortraitDepthMapUsesDirectCoordinates() {
        let width = 6
        let height = 8
        var values = Array(repeating: Float(4), count: width * height)
        fillNeighborhood(value: 0.65, centerX: 3, centerY: 1, width: width, in: &values)
        let snapshot = DepthSnapshot(width: width, height: height, values: values, confidence: [])

        assertDistance(
            snapshot.distance(normalizedBox: [0.65, 0.15, 0.85, 0.35]),
            equals: 0.65,
            named: "portrait depth-map coordinates"
        )
    }

    private static func testBackendNormalizedYOLOBoxMapsToPortraitDepth() {
        let width = 8
        let height = 6
        var values = Array(repeating: Float(4), count: width * height)
        fillNeighborhood(value: 1.25, centerX: 5, centerY: 3, width: width, in: &values)
        let snapshot = DepthSnapshot(width: width, height: height, values: values, confidence: [])

        // Flask /api/detect returns box=[x1/width, y1/height, x2/width, y2/height].
        let normalizedBox = [108.0 / 720, 624.0 / 960, 252.0 / 720, 816.0 / 960]

        assertDistance(
            snapshot.distance(normalizedBox: normalizedBox),
            equals: 1.25,
            named: "normalized Flask YOLO box mapped to ARKit portrait depth"
        )
    }

    private static func testMalformedNormalizedBoxFailsClosed() {
        let snapshot = DepthSnapshot(
            width: 8,
            height: 6,
            values: Array(repeating: Float(1), count: 8 * 6),
            confidence: []
        )
        precondition(
            snapshot.distance(normalizedBox: [0.1, 0.1, 0.1]) == nil,
            "incomplete normalized boxes must not produce LiDAR distances"
        )
        precondition(
            snapshot.distance(normalizedBox: [0.5, 0.5, 0.5, 0.8]) == nil,
            "zero-area normalized boxes must not produce LiDAR distances"
        )
    }

    private static func testCenterDistanceUsesMedian() {
        let width = 8
        let height = 6
        var values = Array(repeating: Float(10), count: width * height)
        var nextValue: Float = 1
        for y in 1...3 {
            for x in 2...4 {
                values[y * width + x] = nextValue
                nextValue += 1
            }
        }
        let snapshot = DepthSnapshot(width: width, height: height, values: values, confidence: [])

        assertDistance(snapshot.centerDistance(), equals: 5, named: "center neighborhood median")
    }

    private static func testLowConfidenceSamplesAreIgnored() {
        let width = 8
        let height = 6
        var values = Array(repeating: Float(0.8), count: width * height)
        var confidence = Array(repeating: UInt8(0), count: width * height)
        let centerIndex = 2 * width + 3
        values[centerIndex] = 2.5
        confidence[centerIndex] = 2
        let snapshot = DepthSnapshot(width: width, height: height, values: values, confidence: confidence)

        assertDistance(snapshot.centerDistance(), equals: 2.5, named: "confidence filtering")

        let allLowConfidence = DepthSnapshot(
            width: width,
            height: height,
            values: Array(repeating: Float(1), count: width * height),
            confidence: Array(repeating: UInt8(0), count: width * height)
        )
        precondition(allLowConfidence.centerDistance() == nil, "all low-confidence readings must be unavailable")
    }

    private static func testCoreVideoDepthAndConfidenceBuffersAreCopied() {
        let width = 8
        let height = 6
        let depthMap = makePixelBuffer(
            width: width,
            height: height,
            pixelFormat: kCVPixelFormatType_DepthFloat32
        )
        let confidenceMap = makePixelBuffer(
            width: width,
            height: height,
            pixelFormat: kCVPixelFormatType_OneComponent8
        )
        fillDepthBuffer(depthMap, value: 1)
        fillConfidenceBuffer(confidenceMap, value: 0)
        writeDepth(2.75, x: 3, y: 2, to: depthMap)
        writeConfidence(2, x: 3, y: 2, to: confidenceMap)

        guard let copied = DepthSnapshot.copy(depthMap: depthMap, confidenceMap: confidenceMap) else {
            preconditionFailure("valid ARKit-style depth buffers must copy")
        }
        precondition(copied.width == width && copied.height == height, "copied depth dimensions must match")
        assertDistance(copied.centerDistance(), equals: 2.75, named: "CoreVideo depth/confidence copy")

        let wrongFormat = makePixelBuffer(width: width, height: height, pixelFormat: kCVPixelFormatType_32BGRA)
        precondition(DepthSnapshot.copy(depthMap: wrongFormat, confidenceMap: nil) == nil, "wrong depth formats must be rejected")
    }

    private static func testInvalidDepthAndMalformedConfidenceFailClosed() {
        let width = 8
        let height = 6
        let invalidDepth = DepthSnapshot(
            width: width,
            height: height,
            values: Array(repeating: Float.nan, count: width * height),
            confidence: []
        )
        precondition(invalidDepth.centerDistance() == nil, "non-finite depths must be unavailable")

        let malformedConfidence = DepthSnapshot(
            width: width,
            height: height,
            values: Array(repeating: Float(1), count: width * height),
            confidence: [2]
        )
        precondition(malformedConfidence.centerDistance() == nil, "malformed confidence maps must fail closed")
    }

    private static func testInvalidDetectionBoxesAreRejected() {
        let snapshot = DepthSnapshot(
            width: 8,
            height: 6,
            values: Array(repeating: Float(1), count: 8 * 6),
            confidence: []
        )
        precondition(snapshot.distance(normalizedBox: [0.8, 0.5, 0.2, 0.7]) == nil, "reversed boxes must be rejected")
        precondition(snapshot.distance(normalizedBox: [Double.nan, 0.1, 0.8, 0.9]) == nil, "non-finite boxes must be rejected")
    }

    private static func fillNeighborhood(
        value: Float,
        centerX: Int,
        centerY: Int,
        width: Int,
        in values: inout [Float]
    ) {
        for y in (centerY - 1)...(centerY + 1) {
            for x in (centerX - 1)...(centerX + 1) {
                values[y * width + x] = value
            }
        }
    }

    private static func assertDistance(_ actual: Double?, equals expected: Double, named name: String) {
        guard let actual else {
            preconditionFailure("\(name): expected \(expected)m, received no distance")
        }
        precondition(abs(actual - expected) < 0.001, "\(name): expected \(expected)m, received \(actual)m")
    }

    private static func makePixelBuffer(width: Int, height: Int, pixelFormat: OSType) -> CVPixelBuffer {
        var pixelBuffer: CVPixelBuffer?
        let result = CVPixelBufferCreate(kCFAllocatorDefault, width, height, pixelFormat, nil, &pixelBuffer)
        precondition(result == kCVReturnSuccess, "CoreVideo test buffer creation failed: \(result)")
        guard let pixelBuffer else { preconditionFailure("CoreVideo returned no test buffer") }
        return pixelBuffer
    }

    private static func fillDepthBuffer(_ pixelBuffer: CVPixelBuffer, value: Float32) {
        precondition(CVPixelBufferLockBaseAddress(pixelBuffer, []) == kCVReturnSuccess, "depth test buffer lock failed")
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            preconditionFailure("depth test buffer has no base address")
        }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float32.self)
            for x in 0..<width {
                row[x] = value
            }
        }
    }

    private static func fillConfidenceBuffer(_ pixelBuffer: CVPixelBuffer, value: UInt8) {
        precondition(CVPixelBufferLockBaseAddress(pixelBuffer, []) == kCVReturnSuccess, "confidence test buffer lock failed")
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            preconditionFailure("confidence test buffer has no base address")
        }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                row[x] = value
            }
        }
    }

    private static func writeDepth(_ value: Float32, x: Int, y: Int, to pixelBuffer: CVPixelBuffer) {
        precondition(CVPixelBufferLockBaseAddress(pixelBuffer, []) == kCVReturnSuccess, "depth test buffer lock failed")
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            preconditionFailure("depth test buffer has no base address")
        }
        let row = base
            .advanced(by: y * CVPixelBufferGetBytesPerRow(pixelBuffer))
            .assumingMemoryBound(to: Float32.self)
        row[x] = value
    }

    private static func writeConfidence(_ value: UInt8, x: Int, y: Int, to pixelBuffer: CVPixelBuffer) {
        precondition(CVPixelBufferLockBaseAddress(pixelBuffer, []) == kCVReturnSuccess, "confidence test buffer lock failed")
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            preconditionFailure("confidence test buffer has no base address")
        }
        let row = base
            .advanced(by: y * CVPixelBufferGetBytesPerRow(pixelBuffer))
            .assumingMemoryBound(to: UInt8.self)
        row[x] = value
    }
}
