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
    let detectorModel: String?
    let inferenceStatus: String?
    let cameraFrameInfo: DeviceFrameInfo?
    let deviceLink: DeviceLinkPayload?
    let zones: [DeviceZone]?
    let corridorDecision: DeviceCorridorDecision?
    let tofAgeMs: Double?
    let tofBootId: String?
    let tofMode: String?
    let tofOk: Bool?
    let audioOk: Bool?
    let operationEnabled: Bool?
    let deviceHealth: DeviceHealthPayload?
    let buttonEvent: DeviceButtonEventPayload?
    let buttonEventAgeMs: Int?
    let buttonEvents: [DeviceButtonEventRecord]?

    enum CodingKeys: String, CodingKey {
        case source, detections, zones
        case corridorDecision = "corridor_decision"
        case cameraInputState = "camera_input_state"
        case cameraAgeMs = "camera_age_ms"
        case cameraFrame = "camera_frame"
        case cameraError = "camera_error"
        case detectionsFrameSeq = "detections_frame_seq"
        case detectionsAgeMs = "detections_age_ms"
        case detectionsBootId = "detections_boot_id"
        case detectorModel = "detector_model"
        case inferenceStatus = "inference_status"
        case cameraFrameInfo = "camera_frame_info"
        case deviceLink = "device_link"
        case tofAgeMs = "tof_age_ms"
        case tofBootId = "tof_boot_id"
        case tofMode = "tof_mode"
        case tofOk = "tof_ok"
        case audioOk = "audio_ok"
        case operationEnabled = "operation_enabled"
        case deviceHealth = "device_health"
        case buttonEvent = "button_event"
        case buttonEventAgeMs = "button_event_age_ms"
        case buttonEvents = "button_events"
    }

    var resolvedOperationEnabled: Bool? {
        if let event = buttonEvent,
           let eventAge = buttonEventAgeMs,
           (0...10_000).contains(eventAge),
           let health = deviceHealth,
           event.deviceId == health.deviceId,
           event.bootId == health.bootId,
           let eventTime = event.tMs,
           let healthTime = health.tMs,
           eventTime > healthTime,
           let enabled = event.operationEnabled {
            return enabled
        }
        return operationEnabled ?? deviceHealth?.operationEnabled ?? buttonEvent?.operationEnabled
    }

    var resolvedDetectionsFrameSeq: Int? {
        detectionsFrameSeq ?? cameraFrameInfo?.detectionsFrameSeq
    }

    var resolvedDetectionsAgeMs: Double? {
        detectionsAgeMs ?? deviceLink?.inferenceAgeMs
    }
}

struct DeviceCorridorDecision: Decodable {
    let origin: String?
    let bootId: String?
    let frameSeq: Int?
    let tofSeq: Int?
    let risk: String?
    let recommendedZone: String?
    let reasonCodes: [String]?

    enum CodingKeys: String, CodingKey {
        case origin, risk
        case bootId = "boot_id"
        case frameSeq = "frame_seq"
        case tofSeq = "tof_seq"
        case recommendedZone = "recommended_zone"
        case reasonCodes = "reason_codes"
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
    let deviceId: String?
    let bootId: String?
    let tMs: Int?
    let operationEnabled: Bool?
    let buttonInputsConfigured: Bool?
    let modeButtonConfigured: Bool?
    let pinProfile: DevicePinProfile?
    let tofOk: Bool?

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id"
        case bootId = "boot_id"
        case tMs = "t_ms"
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
    let type: String?
    let deviceId: String?
    let bootId: String?
    let buttonId: String?
    let action: String?
    let pressedAtMs: Int?
    let pressId: Int?
    let tMs: Int?
    let operationEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case type, action
        case deviceId = "device_id"
        case bootId = "boot_id"
        case buttonId = "button_id"
        case pressedAtMs = "pressed_at_ms"
        case pressId = "press_id"
        case tMs = "t_ms"
        case operationEnabled = "operation_enabled"
    }
}

struct DeviceButtonEventRecord: Decodable {
    let event: DeviceButtonEventPayload
    let ageMs: Int

    enum CodingKeys: String, CodingKey {
        case event
        case ageMs = "age_ms"
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
    let detectorReady: Bool?
    let detectorModel: String?

    enum CodingKeys: String, CodingKey {
        case visionReady = "vision_ready"
        case visionProvider = "vision_provider"
        case detectorReady = "detector_ready"
        case detectorModel = "detector_model"
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

struct DeviceControlResponse: Decodable {
    let command: String?
    let ack: DeviceCommandAck?
    let operationEnabled: Bool?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case command, ack, error
        case operationEnabled = "operation_enabled"
    }
}

struct DeviceCommandAck: Decodable {
    let type: String?
    let requestId: String?
    let command: String?
    let ok: Bool?
    let errorCode: String?

    enum CodingKeys: String, CodingKey {
        case type, command, ok
        case requestId = "request_id"
        case errorCode = "error_code"
    }
}

struct DeviceSpeakerResult: Decodable {
    let schemaVersion: String?
    let requestId: String?
    let state: String?
    let bytesPlayed: Int?
    let durationMs: Double?
    let errorCode: String?

    enum CodingKeys: String, CodingKey {
        case state
        case schemaVersion = "schema_version"
        case requestId = "request_id"
        case bytesPlayed = "bytes_played"
        case durationMs = "duration_ms"
        case errorCode = "error_code"
    }
}
