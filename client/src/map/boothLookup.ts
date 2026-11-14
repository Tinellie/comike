import { readBoothApi } from '../booths/api'
import type { MapBoothLocation } from '../booths/api'
import type { MapBoothHit } from './OsmMapRenderer'

export function mapBoothKey(hit: MapBoothHit) {
  return JSON.stringify([hit.hallGroup, hit.island, hit.number, hit.suffix])
}

export class MapBoothLookup {
  private readonly eventId: string
  private readonly weekday: string
  private readonly cache = new Map<string, Promise<MapBoothLocation>>()
  private readonly controllers = new Set<AbortController>()

  constructor(eventId: string, weekday: string) {
    this.eventId = eventId
    this.weekday = weekday
  }

  load = (hit: MapBoothHit): Promise<MapBoothLocation> => {
    const key = mapBoothKey(hit)
    const cached = this.cache.get(key)
    if (cached) return cached
    const controller = new AbortController()
    this.controllers.add(controller)
    const query = new URLSearchParams({ eventId: this.eventId, weekday: this.weekday, ...hit })
    const request = readBoothApi<MapBoothLocation>(`/location?${query}`, controller.signal)
      .catch((error: unknown) => {
        if (this.cache.get(key) === request) this.cache.delete(key)
        throw error
      })
      .finally(() => this.controllers.delete(controller))
    this.cache.set(key, request)
    return request
  }

  dispose() {
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.cache.clear()
  }
}
