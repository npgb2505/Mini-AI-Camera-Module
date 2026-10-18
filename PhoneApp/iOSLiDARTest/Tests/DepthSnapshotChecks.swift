import Foundation

@main
enum DepthSnapshotChecks {
    static func main() {
        testLandscapeDepthMapUsesPortraitDetectionCoordinates()
        testPortraitDepthMapUsesDirectCoordinates()
        testCenterDistanceUsesMedian()
        testLowConfidenceSamplesAreIgnored()
        testInvalidDepthAndMalformedConfidenceFailClosed()
        testInvalidDetectionBoxesAreRejected()
        print("DepthSnapshot checks passed: 6 cases")
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
}
