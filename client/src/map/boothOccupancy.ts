import type { MapBoothData } from '../booths/api'
import type { HallVisibility } from './hallVisibility'
import type { PreviewBooth } from '../preview/data'
import type { MapHall } from './halls'
import { mergeVacancyRegions } from './vacancyRegions'

export class BoothOccupancy {
  private readonly merged: Map<string, Set<string>>
  private readonly vacancies: Map<string, Set<string>>
  private readonly regions = new WeakMap<MapHall, readonly PreviewBooth['bbox'][]>()

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

  vacancyRegions(hall: MapHall): readonly PreviewBooth['bbox'][] {
    const cached = this.regions.get(hall)
    if (cached) return cached
    const parents = new Map(hall.page.booths.map(booth => [booth.id, booth]))
    const boxes: PreviewBooth['bbox'][] = []
    for (const half of hall.page.halfBooths ?? []) {
      const booth = parents.get(half.boothId)
      const island = booth?.islandId ? hall.islandCodes.get(booth.islandId) : null
      if (island && booth?.number && half.suffix && this.isVacant(island, booth.number, half.suffix)) boxes.push(half.bbox)
    }
    const regions = mergeVacancyRegions(boxes)
    this.regions.set(hall, regions)
    return regions
  }
}

export function boothHover(
  hit: NonNullable<ReturnType<HallVisibility['hitTest']>>, island: string | null, occupancy: BoothOccupancy | null,
): { bbox: PreviewBooth['bbox'] | null; suffix: string } {
  if (island !== null && hit.booth.number !== null && hit.half.suffix
    && occupancy?.isVacant(island, hit.booth.number, hit.half.suffix)) {
    return { bbox: null, suffix: hit.half.suffix }
  }
  const merged = island !== null && hit.booth.number !== null && occupancy?.isMerged(island, hit.booth.number)
  return { bbox: merged ? hit.booth.bbox : hit.half.bbox, suffix: merged ? 'ab' : hit.half.suffix ?? '?' }
}
