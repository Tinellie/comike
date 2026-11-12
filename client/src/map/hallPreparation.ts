import { parseHallTransforms } from './halls'
import type { HallTransforms, MapHall } from './halls'
import type { OsmMapData } from './osm'
import { registerHall } from './hallRegistration'
import type { HallRegistrationReport } from './hallRegistration'

export function hallBoothAspectRatio(hall: MapHall): { width: number; height: number; aspectRatio: number } | null {
  const sizes = new Map<string, { width: number; height: number; count: number }>()
  for (const { bbox: { width, height } } of hall.page.booths) {
    const key = `${width}:${height}`, size = sizes.get(key)
    if (size) size.count++
    else sizes.set(key, { width, height, count: 1 })
  }
  const sample = [...sizes.values()].sort((a, b) => b.count - a.count)[0]
  return sample ? { width: sample.width, height: sample.height, aspectRatio: sample.height / sample.width } : null
}

export function correctHallAspectRatios(halls: MapHall[], transforms: HallTransforms): HallTransforms {
  const validated = parseHallTransforms(transforms, halls)
  const ratios = new Map(halls.map(hall => {
    const sample = hallBoothAspectRatio(hall)
    const name = hall.name ?? `Hall ${hall.index + 1}`
    if (!sample) throw new Error(`${name} 没有 Booth，无法重新计算变换`)
    if (!Number.isFinite(sample.aspectRatio) || sample.aspectRatio < 0.01 || sample.aspectRatio > 100) {
      throw new Error(`${name} 的 Booth 长宽比超出支持范围（0.01–100）`)
    }

    return [hall.index, sample.aspectRatio]
  }))
  return {
    ...validated,
    placements: validated.placements.map(placement => {
      const aspectRatio = ratios.get(placement.hallIndex)
      if (aspectRatio === undefined) throw new Error('重新计算变换时缺少 Hall 数据')
      return { ...placement, aspectRatio }
    }),
  }
}

export function recalculateHallTransforms(halls: MapHall[], transforms: HallTransforms, map: OsmMapData): {
  transforms: HallTransforms; reports: HallRegistrationReport[]
} {
  const corrected = correctHallAspectRatios(halls, transforms)
  const fitted = corrected.placements.map(placement => {
    const hall = halls.find(hall => hall.index === placement.hallIndex)
    if (!hall) throw new Error('自动配准时缺少 Hall 数据')
    try {
      return registerHall(hall, placement, map)
    } catch (cause) {
      throw new Error(`${hall.name ?? `Hall ${hall.index + 1}`}：${cause instanceof Error ? cause.message : '自动配准失败'}`, { cause })
    }
  })
  return {
    transforms: parseHallTransforms({ ...corrected, placements: fitted.map(result => result.placement) }, halls),
    reports: fitted.map(result => result.report),
  }
}
