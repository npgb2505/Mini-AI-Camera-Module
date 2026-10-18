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

        guard ARWorldTrackingConfiguration.isSupported else {
            model.updatePhoneSceneDepthSupport(false)
            model.updateCameraStatus("ARKit camera không được hỗ trợ trên thiết bị này; chưa có ảnh hoặc khoảng cách.")
            return view
        }

        let configuration = ARWorldTrackingConfiguration()
        let sceneDepthSupported = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
        model.updatePhoneSceneDepthSupport(sceneDepthSupported)
        if sceneDepthSupported {
            configuration.frameSemantics = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
                ? [.sceneDepth, .smoothedSceneDepth]
                : [.sceneDepth]
        }
        context.coordinator.setSessionConfiguration(configuration)
        view.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        model.updateCameraStatus(sceneDepthSupported
            ? "Đang chờ camera và ARKit sceneDepth…"
            : "Camera iPhone đã chạy; thiết bị không hỗ trợ sceneDepth nên chưa có khoảng cách.")
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
        private static let minimumFrameInterval: TimeInterval = 0.4
        private weak var model: CameraModel?
        private let stateLock = NSLock()
        private var detectionEnabled = false
        private var lastDepthUpdate = 0.0
        private var lastFrameUpdate = 0.0
        private var didReceiveSceneDepth = false
        private var didReportMissingSceneDepth = false
        private var sessionConfiguration: ARWorldTrackingConfiguration?
        private let imageContext = CIContext()

        init(model: CameraModel) {
            self.model = model
        }

        func setDetectionEnabled(_ enabled: Bool) {
            stateLock.lock()
            detectionEnabled = enabled
            stateLock.unlock()
        }

        func setSessionConfiguration(_ configuration: ARWorldTrackingConfiguration) {
            sessionConfiguration = configuration
        }

        func session(_ session: ARSession, didUpdate frame: ARFrame) {
            let now = frame.timestamp
            let depthData = frame.smoothedSceneDepth ?? frame.sceneDepth

            if depthData != nil, !didReceiveSceneDepth {
                didReceiveSceneDepth = true
                let model = self.model
                Task { @MainActor [weak model] in
                    model?.updateCameraStatus("ARKit đã cung cấp sceneDepth; khoảng cách hiển thị là ước tính cần kiểm tra thực tế.")
                }
            } else if depthData == nil, !didReceiveSceneDepth, !didReportMissingSceneDepth {
                didReportMissingSceneDepth = true
                let model = self.model
                Task { @MainActor [weak model] in
                    model?.updateCameraStatus("Camera đã có frame nhưng ARKit chưa trả sceneDepth; chưa hiển thị khoảng cách.")
                }
            }

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

            guard now - lastFrameUpdate >= Self.minimumFrameInterval,
                  let jpeg = jpegFrame(frame.capturedImage) else {
                return
            }
            lastFrameUpdate = now
            let snapshot = depthData.flatMap {
                DepthSnapshot.copy(depthMap: $0.depthMap, confidenceMap: $0.confidenceMap)
            }

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
                model?.updateCenterDistance(nil)
                model?.updateCameraStatus("Không mở được camera. Kiểm tra quyền Camera trong Cài đặt iPhone, rồi rời chế độ iPhone và mở lại.")
            }
        }

        func sessionWasInterrupted(_ session: ARSession) {
            Task { @MainActor [weak model] in
                model?.updateCenterDistance(nil)
                model?.updateCameraStatus("Camera tạm dừng. Giữ iPhone hướng về cảnh; app sẽ nối lại khi camera sẵn sàng.")
            }
        }

        func sessionInterruptionEnded(_ session: ARSession) {
            didReceiveSceneDepth = false
            didReportMissingSceneDepth = false
            if let sessionConfiguration {
                session.run(sessionConfiguration, options: [.resetTracking, .removeExistingAnchors])
            }
            Task { @MainActor [weak model] in
                model?.updateCenterDistance(nil)
                model?.updateCameraStatus("Camera đã hoạt động lại; đang chờ frame và sceneDepth mới.")
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
