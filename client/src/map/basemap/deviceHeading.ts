interface OrientationReading {
  alpha: number | null
  beta: number | null
  gamma: number | null
  absolute: boolean
  webkitCompassHeading?: number
  webkitCompassAccuracy?: number
}

export function smoothMapRotation(current: number, target: number, elapsedMs: number): number {
  const delta = ((target - current + 180) % 360 + 360) % 360 - 180
  if (Math.abs(delta) < 0.05) return current + delta
  return current + delta * (1 - Math.exp(-Math.max(0, elapsedMs) / 120))
}

export function mapRotationFromOrientation(event: OrientationReading, screenAngle: number): number | null {
  const { alpha, beta, gamma, webkitCompassHeading, webkitCompassAccuracy } = event
  if (!Number.isFinite(screenAngle)) return null
  if (typeof webkitCompassHeading === 'number' && Number.isFinite(webkitCompassHeading)
    && webkitCompassHeading >= 0 && webkitCompassHeading <= 360
    && (webkitCompassAccuracy === undefined || (Number.isFinite(webkitCompassAccuracy) && webkitCompassAccuracy >= 0))) {
    return -webkitCompassHeading - screenAngle
  }
  if (!event.absolute || alpha === null || beta === null || gamma === null
    || !Number.isFinite(alpha) || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null

  const radians = Math.PI / 180
  const a = alpha * radians, b = beta * radians, g = gamma * radians, s = screenAngle * radians
  // Project the screen's upward axis into the east/north plane using the Z-X-Y device rotation.
  const east = Math.sin(s) * (Math.cos(a) * Math.cos(g) - Math.sin(a) * Math.sin(b) * Math.sin(g))
    - Math.cos(s) * Math.sin(a) * Math.cos(b)
  const north = Math.sin(s) * (Math.sin(a) * Math.cos(g) + Math.cos(a) * Math.sin(b) * Math.sin(g))
    + Math.cos(s) * Math.cos(a) * Math.cos(b)
  if (Math.hypot(east, north) < 0.1) return null
  return -Math.atan2(east, north) / radians
}
