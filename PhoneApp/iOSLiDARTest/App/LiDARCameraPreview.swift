import ARKit
import CoreImage
import ImageIO
import SceneKit
import SwiftUI
import UniformTypeIdentifiers

struct LiDARCameraPreview: UIViewRepresentable {
    @ObservedObject var model: CameraModel

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model)
    }

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.scene = SCNScene()
        view.automaticallyUpdatesLighting = false
        view.backgroundColor = .black
        view.session.delegate = context.coordinator
        view.session.delegateQueue = DispatchQueue(label: "vn.khiemthi.rosight.arsession")

        guard ARWorldTrackingConfiguration.isSupported,
              ARWorldTrackingConfiguration.supportsFrameSemantics([.sceneDepth, .smoothedSceneDepth]) else {
            model.updateCameraStatus("Thiết bị chưa hỗ trợ LiDAR scene depth của ARKit.")
            return view
        }

        let configuration = ARWorldTrackingConfiguration()
        configuration.frameSemantics = [.sceneDepth, .smoothedSceneDepth]
        view.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        model.updateCameraStatus("Camera sau và LiDAR đang chạy.")
        return view
    }

    func updateUIView(_ view: ARSCNView, context: Context) {
        context.coordinator.setDetectionEnabled(model.detectionEnabled)
    }

    static func dismantleUIView(_ view: ARSCNView, coordinator: Coordinator) {
        view.session.pause()
        view.session.delegate = nil
    }

    final class Coordinator: NSObject, ARSessionDelegate {
        private weak var model: CameraModel?
        private let stateLock = NSLock()
        private var detectionEnabled = false
        private var lastDepthUpdate = 0.0
        private var lastFrameUpdate = 0.0
        private let imageContext = CIContext()

        init(model: CameraModel) {
            self.model = model
        }

        func setDetectionEnabled(_ enabled: Bool) {
            stateLock.lock()
            detectionEnabled = enabled
            stateLock.unlock()
        }

        func session(_ session: ARSession, didUpdate frame: ARFrame) {
            let now = frame.timestamp
            let depthData = frame.smoothedSceneDepth ?? frame.sceneDepth

            if now - lastDepthUpdate >= 0.25 {
                lastDepthUpdate = now
                let center = depthData.flatMap {
                    DepthSnapshot.copy(depthMap: $0.depthMap, confidenceMap: $0.confidenceMap)?.centerDistance()
                }
                let model = self.model
                Task { @MainActor [weak model] in
                    model?.updateCenterDistance(center)
                }
            }

            guard now - lastFrameUpdate >= 0.9,
                  let depthData,
                  let snapshot = DepthSnapshot.copy(
                    depthMap: depthData.depthMap,
                    confidenceMap: depthData.confidenceMap
                  ),
                  let jpeg = jpegFrame(frame.capturedImage) else {
                return
            }
            lastFrameUpdate = now

            stateLock.lock()
            let shouldRunYOLO = detectionEnabled
            stateLock.unlock()

            let model = self.model
            Task { @MainActor [weak model] in
                await model?.receiveFrame(jpeg, depth: snapshot, shouldRunYOLO: shouldRunYOLO)
            }
        }

        func session(_ session: ARSession, didFailWithError error: Error) {
            Task { @MainActor [weak model] in
                model?.updateCameraStatus("Camera/LiDAR lỗi: \(error.localizedDescription)")
            }
        }

        private func jpegFrame(_ pixelBuffer: CVPixelBuffer) -> Data? {
            let portrait = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
            let largestSide = max(portrait.extent.width, portrait.extent.height)
            let scale = min(1, 960 / largestSide)
            let resized = portrait.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            guard let cgImage = imageContext.createCGImage(resized, from: resized.extent) else {
                return nil
            }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                output,
                UTType.jpeg.identifier as CFString,
                1,
                nil
            ) else {
                return nil
            }
            CGImageDestinationAddImage(
                destination,
                cgImage,
                [kCGImageDestinationLossyCompressionQuality: 0.62] as CFDictionary
            )
            guard CGImageDestinationFinalize(destination) else { return nil }
            return output as Data
        }
    }
}
