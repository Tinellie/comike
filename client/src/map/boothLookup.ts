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
  private readonly previews = new Map<string, Promise<MapBoothLocation>>()
  private readonly images = new Map<string, Promise<HTMLImageElement>>()
  private generation = 0

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

  preview = (hit: MapBoothHit): Promise<MapBoothLocation> => {
    const key = mapBoothKey(hit)
    const cached = this.previews.get(key)
    if (cached) return cached
    const generation = this.generation
    const request = this.load(hit).then(async data => {
      if (generation !== this.generation) throw new DOMException('Preview cancelled', 'AbortError')
      await Promise.all([...new Set(data.circles.flatMap(circle => circle.imageUrls))].map(url => this.loadImage(url)))
      return data
    }).catch((error: unknown) => {
      if (this.previews.get(key) === request) this.previews.delete(key)
      throw error
    })
    this.previews.set(key, request)
    return request
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    const cached = this.images.get(url)
    if (cached) return cached
    const image = new Image()
    image.src = url
    const request = image.decode().then(() => image).catch((reason: unknown) => {
      if (this.images.get(url) === request) this.images.delete(url)
      throw new Error('社团图片加载失败，请重新悬浮重试', { cause: reason })
    })
    this.images.set(url, request)
    return request
  }

  dispose() {
    this.generation++
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.cache.clear()
    this.previews.clear()
    this.images.clear()
  }
}
