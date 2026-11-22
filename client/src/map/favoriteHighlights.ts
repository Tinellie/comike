import type { MapFavorite, MapRectangle } from '../booths/api'
import type { PreviewBooth } from '../preview/data'
import type { MapHall } from './halls'

export interface FavoriteHighlight {
  colour: string
  rectangles: MapRectangle[]
}

export interface FavoriteHighlights {
  byHall: ReadonlyMap<number, readonly FavoriteHighlight[]>
  stops: readonly { hallIndex: number; booth: PreviewBooth; bbox: MapRectangle; colours: string[] }[]
  unmatched: number
  unmatchedByColour: ReadonlyMap<string, number>
}

export function favoriteHighlights(halls: readonly MapHall[], favorites: readonly MapFavorite[]): FavoriteHighlights {
  const byHall = new Map<number, FavoriteHighlight[]>()
  const stops: FavoriteHighlights['stops'][number][] = []
  const unmatchedByColour = new Map<string, number>()
  if (!favorites.length || !halls.length) return { byHall, stops, unmatched: 0, unmatchedByColour }
  type Cell = { hallIndex: number; booth: PreviewBooth; halves: ReadonlyMap<string, MapRectangle> }
  const cells = new Map<string, Cell[]>()
  const key = (hall: string, island: string, number: string) => JSON.stringify([hall, island.normalize('NFKC'), number.padStart(2, '0')])
  for (const hall of halls) {
    if (!hall.name) continue
    const halves = new Map<string, Map<string, MapRectangle>>()
    for (const half of hall.page.halfBooths ?? []) {
      if (!half.suffix) continue
      const entries = halves.get(half.boothId) ?? new Map<string, MapRectangle>()
      entries.set(half.suffix, half.bbox)
      halves.set(half.boothId, entries)
    }
    for (const booth of hall.page.booths) {
      const island = booth.islandId ? hall.islandCodes.get(booth.islandId) : null
      if (!island || !booth.number) continue
      const location = key(hall.name, island, booth.number)
      const entries = cells.get(location) ?? []
      entries.push({ hallIndex: hall.index, booth, halves: halves.get(booth.id) ?? new Map() })
      cells.set(location, entries)
    }
  }
  let unmatched = 0
  const seen = new Map<MapRectangle, string[]>()
  for (const favorite of favorites) {
    const matches = cells.get(key(favorite.hallGroup, favorite.island, favorite.number))
    const cell = matches?.length === 1 ? matches[0] : undefined
    const bbox = favorite.suffix === 'ab' ? cell?.booth.bbox : cell?.halves.get(favorite.suffix ?? '')
    if (!cell || !bbox) {
      unmatched++
      unmatchedByColour.set(favorite.colour, (unmatchedByColour.get(favorite.colour) ?? 0) + 1)
      continue
    }
    let colours = seen.get(bbox)
    if (!colours) {
      colours = []
      stops.push({ hallIndex: cell.hallIndex, booth: cell.booth, bbox, colours })
      seen.set(bbox, colours)
    }
    if (!colours.includes(favorite.colour)) colours.push(favorite.colour)
    const groups = byHall.get(cell.hallIndex) ?? []
    let group = groups.find(entry => entry.colour === favorite.colour)
    if (!group) {
      group = { colour: favorite.colour, rectangles: [] }
      groups.push(group)
    }
    group.rectangles.push(bbox)
    byHall.set(cell.hallIndex, groups)
  }
  return { byHall, stops, unmatched, unmatchedByColour }
}
