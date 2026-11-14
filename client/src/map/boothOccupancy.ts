import type { MapBoothData } from '../booths/api'
import type { HallVisibility } from './hallVisibility'
import type { PreviewBooth } from '../preview/data'

export class BoothOccupancy {
  private readonly merged: Map<string, Set<string>>
  private readonly vacancies: Map<string, Set<string>>

  constructor(data: MapBoothData) {
    const index = (groups: Record<string, string[]>) => new Map(
      Object.entries(groups).map(([island, numbers]) => [island.normalize('NFKC'), new Set(numbers)]),
    )
    this.merged = index(data.merged)
    this.vacancies = index(data.vacancies)
  }

  isMerged(island: string, number: string) {
    return this.merged.get(island.normalize('NFKC'))?.has(number.padStart(2, '0')) ?? false
  }

  isVacant(island: string, number: string, suffix: string) {
    return this.vacancies.get(island.normalize('NFKC'))?.has(`${number.padStart(2, '0')}${suffix}`) ?? false
  }
}

export function boothHover(
  hit: NonNullable<ReturnType<HallVisibility['hitTest']>>, island: string | null, occupancy: BoothOccupancy | null,
): { bbox: PreviewBooth['bbox']; suffix: string } {
  const merged = island !== null && hit.booth.number !== null && occupancy?.isMerged(island, hit.booth.number)
  return { bbox: merged ? hit.booth.bbox : hit.half.bbox, suffix: merged ? 'ab' : hit.half.suffix ?? '?' }
}
