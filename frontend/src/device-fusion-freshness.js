const ZONES = ['left', 'center', 'right']
const RISKS = ['clear', 'caution', 'stop', 'unknown']
const LANE_STATES = ['open', 'caution', 'blocked', 'unknown']

function validNonNegativeAge(age, ttl) {
  return Number.isFinite(age) && Number.isFinite(ttl) && ttl >= 0 && age >= 0 && age <= ttl
}

function hasValidTofLanes(lanes) {
  if (!Array.isArray(lanes) || lanes.length !== ZONES.length) return false
  return ZONES.every((zone, index) => {
    const lane = lanes[index]
    if (!lane || lane.zone !== zone || typeof lane.tof_valid !== 'boolean'
        || typeof lane.camera_valid !== 'boolean' || typeof lane.camera_blocked !== 'boolean'
        || !LANE_STATES.includes(lane.status)) return false
    return lane.tof_valid
      ? Number.isInteger(lane.nearest_mm) && lane.nearest_mm > 0
      : lane.nearest_mm === null
  })
}

function hasValidStatusZones(zones) {
  if (!Array.isArray(zones) || zones.length !== ZONES.length) return false
  return ZONES.every((zone, index) => {
    const reading = zones[index]
    if (!reading || reading.zone !== zone || typeof reading.tof_valid !== 'boolean') return false
    return reading.tof_valid
      ? Number.isFinite(reading.nearest_cm) && reading.nearest_cm > 0
      : reading.nearest_cm === null
  }) && zones.some((reading) => reading.tof_valid)
}

export function isFreshDeviceFusion({
  transport,
  linked,
  operationReady,
  status,
  cameraAgeMs,
  cameraTtlMs,
  tofAgeMs,
  tofTtlMs,
  detectionFrameSeq,
}) {
  if (transport !== 'firmware_wifi' || linked !== true || operationReady !== true
      || !status || status.source !== 'device' || status.camera_input_state !== 'live'
      || !validNonNegativeAge(cameraAgeMs, cameraTtlMs)
      ) return false

  const health = status.device_health || {}
  const deviceId = health.device_id || status.device_id
  const bootId = health.boot_id || status.boot_id
  const frameSeq = status.camera_frame
  const decision = status.corridor_decision
  if (typeof deviceId !== 'string' || !deviceId || typeof bootId !== 'string' || !bootId
      || !Number.isInteger(frameSeq) || frameSeq < 1
      || !decision || decision.type !== 'corridor_decision' || decision.origin !== 'device'
      || decision.device_id !== deviceId || decision.boot_id !== bootId
      || !Number.isInteger(decision.frame_seq) || decision.frame_seq !== frameSeq
      || !RISKS.includes(decision.risk) || !hasValidTofLanes(decision.lanes)) return false

  if (decision.input_origins?.length !== 1 || decision.input_origins[0] !== 'device'
      || !['left', 'center', 'right', 'stop', 'unknown'].includes(decision.recommended_zone)) return false
  const lanes = decision.lanes
  const zones = status.zones
  const hasLaneTof = lanes.some((lane) => lane.tof_valid)
  const tofEvidenceFresh = status.tof_mode === 'device' && status.tof_ok === true
    && status.tof_boot_id === bootId && status.tof_frame_seq === frameSeq
    && validNonNegativeAge(tofAgeMs, tofTtlMs)
    && Number.isInteger(decision.tof_seq) && decision.tof_seq > 0
    && hasValidStatusZones(zones)
  const sameTof = tofEvidenceFresh && ZONES.every((zone, index) => {
    const lane = lanes[index]
    const reading = zones[index]
    return lane.tof_valid === reading.tof_valid
      && (lane.tof_valid ? Math.abs(lane.nearest_mm / 10 - reading.nearest_cm) < 0.05 : reading.nearest_cm === null)
  })
  if (decision.risk === 'clear') {
    const everyLaneClear = lanes.every((lane) => lane.camera_valid && lane.tof_valid && lane.status === 'open')
    if (!sameTof || !everyLaneClear) return false
  } else if (decision.risk === 'caution' || decision.risk === 'stop') {
    const cameraHazard = lanes.some((lane) => lane.camera_valid && lane.camera_blocked
      && ['caution', 'blocked'].includes(lane.status))
    const tofHazard = sameTof && lanes.some((lane) => lane.tof_valid && ['caution', 'blocked'].includes(lane.status))
    if (!cameraHazard && !tofHazard) return false
  } else if (hasLaneTof && !sameTof) {
    return false
  }
  return !Number.isInteger(detectionFrameSeq) || detectionFrameSeq === frameSeq
}
