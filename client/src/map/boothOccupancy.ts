import type { MapBoothData, MapRectangle } from '../booths/api'
import type { HallVisibility } from './hallVisibility'
import type { PreviewBooth } from '../preview/data'
import type { MapHall } from './halls'

export class BoothOccupancy {
  private readonly merged: Map<string, Set<string>>
  private readonly vacancies: Map<string, Set<string>>
  private readonly regions: Map<string, MapRectangle[]>
  private readonly genres: Map<string, { key: string; color: string; rectangles: MapRectangle[] }[]>

  constructor(data: MapBoothData) {
    const index = (groups: Record<string, string[]>) => new Map(
      Object.entries(groups).map(([island, numbers]) => [island.normalize('NFKC'), new Set(numbers)]),
    )
    this.merged = index(data.merged)
    this.vacancies = index(data.vacancies)
    this.regions = new Map(data.vacancyRegions.map(row => [row.hallGroup, row.rectangles]))
    const colors = new Map(data.genres.map(genre => [genre.key, genre.color]))
    this.genres = new Map()
    for (const row of data.genreRegions) {
      const color = colors.get(row.genreKey)
      if (!color) throw new Error('genre 范围缺少颜色数据，请重新整理')
      const groups = this.genres.get(row.hallGroup) ?? []
      groups.push({ key: row.genreKey, color, rectangles: row.rectangles })
      this.genres.set(row.hallGroup, groups)
    }
  }

  isMerged(island: string, number: string) {
    return this.merged.get(island.normalize('NFKC'))?.has(number.padStart(2, '0')) ?? false
  }

  isVacant(island: string, number: string, suffix: string) {
    return this.vacancies.get(island.normalize('NFKC'))?.has(`${number.padStart(2, '0')}${suffix}`) ?? false
  }

  vacancyRegions(hall: MapHall): readonly PreviewBooth['bbox'][] {
    return hall.name ? this.regions.get(hall.name) ?? emptyRegions : emptyRegions
  }

  genreRegions(hall: MapHall) {
    return hall.name ? this.genres.get(hall.name) ?? [] : []
  }
}

const emptyRegions: readonly MapRectangle[] = []
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
