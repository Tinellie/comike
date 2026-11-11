export function validHallTransforms(value: unknown, names: unknown[]): boolean {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.placements)
    || value.placements.length !== names.length || names.length === 0) return false
  const indices = new Set<number>()
  for (const p of value.placements) {
    if (!record(p) || !finite(p.hallIndex) || !Number.isSafeInteger(p.hallIndex)
      || p.hallIndex < 0 || p.hallIndex >= names.length || indices.has(p.hallIndex)
      || p.name !== names[p.hallIndex] || !record(p.anchor) || !record(p.offset)
      || !finite(p.anchor.latitude) || Math.abs(p.anchor.latitude) > 85
      || !finite(p.anchor.longitude) || Math.abs(p.anchor.longitude) > 180
      || !finite(p.offset.x) || !finite(p.offset.y)
      || !finite(p.rotation) || Math.abs(p.rotation) > 36000
      || !finite(p.scale) || p.scale < 0.001 || p.scale > 10
      || Object.keys(p).some(key => !['hallIndex', 'name', 'anchor', 'offset', 'rotation', 'scale'].includes(key))
      || Object.keys(p.anchor).some(key => !['latitude', 'longitude'].includes(key))
      || Object.keys(p.offset).some(key => !['x', 'y'].includes(key))) return false
    indices.add(p.hallIndex)
  }
  return Object.keys(value).every(key => ['schemaVersion', 'placements'].includes(key))
}
