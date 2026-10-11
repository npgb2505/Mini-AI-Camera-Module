import Foundation

struct DeviceConnectionPayload: Decodable {
    let available: Bool?
    let deviceConnected: Bool?
    let state: String?
    let transport: String?
    let status: DeviceStatusPayload?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case available, state, status, error, transport
        case deviceConnected = "device_connected"
    }
}

struct DeviceStatusPayload: Decodable {
    let source: String?
    let cameraInputState: String?
    let cameraAgeMs: Double?
    let cameraFrame: Int?
    let cameraError: String?
    let detections: [DeviceDetection]?
    let detectionsFrameSeq: Int?
    let detectionsAgeMs: Double?
    let detectionsBootId: String?
    let cameraFrameInfo: DeviceFrameInfo?
    let deviceLink: DeviceLinkPayload?
    let zones: [DeviceZone]?
    let tofAgeMs: Double?
    let tofBootId: String?
    let tofMode: String?
    let operationEnabled: Bool?
    let deviceHealth: DeviceHealthPayload?
    let buttonEvent: DeviceButtonEventPayload?

    enum CodingKeys: String, CodingKey {
        case source, detections, zones
        case cameraInputState = "camera_input_state"
        case cameraAgeMs = "camera_age_ms"
        case cameraFrame = "camera_frame"
        case cameraError = "camera_error"
        case detectionsFrameSeq = "detections_frame_seq"
        case detectionsAgeMs = "detections_age_ms"
        case detectionsBootId = "detections_boot_id"
        case cameraFrameInfo = "camera_frame_info"
        case deviceLink = "device_link"
        case tofAgeMs = "tof_age_ms"
        case tofBootId = "tof_boot_id"
        case tofMode = "tof_mode"
        case operationEnabled = "operation_enabled"
        case deviceHealth = "device_health"
        case buttonEvent = "button_event"
    }

    var resolvedOperationEnabled: Bool? {
        operationEnabled ?? deviceHealth?.operationEnabled ?? buttonEvent?.operationEnabled
    }

    var resolvedDetectionsFrameSeq: Int? {
        detectionsFrameSeq ?? cameraFrameInfo?.detectionsFrameSeq
    }

    var resolvedDetectionsAgeMs: Double? {
        detectionsAgeMs ?? deviceLink?.inferenceAgeMs
    }
}

struct DeviceFrameInfo: Decodable {
    let detectionsFrameSeq: Int?

    enum CodingKeys: String, CodingKey {
        case detectionsFrameSeq = "detections_frame_seq"
    }
}

struct DeviceLinkPayload: Decodable {
    let state: String?
    let transport: String?
    let inferenceAgeMs: Double?

    enum CodingKeys: String, CodingKey {
        case state, transport
        case inferenceAgeMs = "inference_age_ms"
    }
}

struct DeviceHealthPayload: Decodable {
    let bootId: String?
    let operationEnabled: Bool?
    let buttonInputsConfigured: Bool?
    let modeButtonConfigured: Bool?
    let pinProfile: DevicePinProfile?
    let tofOk: Bool?

    enum CodingKeys: String, CodingKey {
        case bootId = "boot_id"
        case operationEnabled = "operation_enabled"
        case buttonInputsConfigured = "button_inputs_configured"
        case modeButtonConfigured = "mode_button_configured"
        case pinProfile = "pin_profile"
        case tofOk = "tof_ok"
    }
}

struct DevicePinProfile: Decodable {
    let id: String?
    let cameraMapStatus: String?
    let externalMapStatus: String?

    enum CodingKeys: String, CodingKey {
        case id
        case cameraMapStatus = "camera_map_status"
        case externalMapStatus = "external_map_status"
    }
}

struct DeviceButtonEventPayload: Decodable {
    let operationEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case operationEnabled = "operation_enabled"
    }
}

struct DeviceDetection: Decodable, Identifiable {
    let className: String?
    let label: String?
    let labelVi: String?
    let confidence: Double?

    enum CodingKeys: String, CodingKey {
        case confidence, label
        case className = "class_name"
        case labelVi = "label_vi"
    }

    var id: String {
        "\(displayLabel)-\(confidence ?? 0)"
    }

    var displayLabel: String {
        className ?? labelVi ?? label ?? "Vật thể"
    }
}

struct DeviceZone: Decodable, Identifiable {
    let zone: String
    let nearestCm: Double?
    let tofValid: Bool
    let blockedByCamera: Bool?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case zone, status
        case nearestCm = "nearest_cm"
        case tofValid = "tof_valid"
        case blockedByCamera = "blocked_by_camera"
    }

    var id: String { zone }
}

struct DeviceCapabilitiesPayload: Decodable {
    let visionReady: Bool
    let visionProvider: String?

    enum CodingKeys: String, CodingKey {
        case visionReady = "vision_ready"
        case visionProvider = "vision_provider"
    }
}

struct DeviceAskPayload: Decodable {
    let answer: String?
    let error: String?
    let frameSeq: Int?
    let visionUsed: Bool?

    enum CodingKeys: String, CodingKey {
        case answer, error
        case frameSeq = "frame_seq"
        case visionUsed = "vision_used"
    }
}
