import { mercatorWorldWidth, viewportBounds } from './viewport'
import type { Point, Size, Viewport } from './viewport'

export const worldImageryService = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
const maxZoom = 19 // The venue's higher levels return a "Map data not yet available" tile.
const maxVisibleTiles = 64
const maxCachedTiles = 128
const halfWorld = mercatorWorldWidth / 2

export interface ImageryTile {
  zoom: number
  row: number
  col: number
  x: number
  y: number
  width: number
}

export function imageryTiles(view: Viewport, size: Size, pixelRatio: number): ImageryTile[] {
  const bounds = viewportBounds(view, size)
  const zoom = Math.max(0, Math.min(maxZoom, Math.round(Math.log2(mercatorWorldWidth * view.scale * pixelRatio / 256))))
  for (let z = zoom; z >= 0; z--) {
    const count = 2 ** z
    const width = mercatorWorldWidth / count
    const first = (value: number) => Math.max(0, Math.floor((value + halfWorld) / width))
    const last = (value: number) => Math.min(count - 1, Math.ceil((value + halfWorld) / width) - 1)
    const minRow = first(bounds.minY), maxRow = last(bounds.maxY)
    const minCol = first(bounds.minX), maxCol = last(bounds.maxX)
    if (minRow > maxRow || minCol > maxCol) return []
    if ((maxRow - minRow + 1) * (maxCol - minCol + 1) > maxVisibleTiles) continue
    const tiles: ImageryTile[] = []
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        tiles.push({ zoom: z, row, col, x: col * width - halfWorld, y: row * width - halfWorld, width })
      }
    }
    return tiles
  }
  return []
}

type TileImage = { image: HTMLImageElement; status: 'loading' | 'ready' | 'failed' }

export class SatelliteImagery {
  private readonly cache = new Map<string, TileImage>()
  private hasError = false
  private readonly redraw: () => void
  private readonly onError: (failed: boolean) => void

  constructor(redraw: () => void, onError: (failed: boolean) => void) {
    this.redraw = redraw
    this.onError = onError
  }

  draw(ctx: CanvasRenderingContext2D, view: Viewport, size: Size, pixelRatio: number, origin: Point) {
    let failed = false
    for (const { zoom, row, col, x, y, width } of imageryTiles(view, size, pixelRatio)) {
      const key = `${zoom}/${row}/${col}`
      const tile = this.cache.get(key) ?? this.load(key)
      this.cache.delete(key)
      this.cache.set(key, tile)
      if (tile.status === 'ready') ctx.drawImage(tile.image, x - origin.x, y - origin.y, width, width)
      if (tile.status === 'failed') failed = true
    }
    for (const [key, tile] of this.cache) {
      if (this.cache.size <= maxCachedTiles) break
      this.remove(key, tile)
    }
    if (failed !== this.hasError) {
      this.hasError = failed
      this.onError(failed)
    }
  }

  private load(key: string): TileImage {
    const image = new Image()
    const tile: TileImage = { image, status: 'loading' }
    image.onload = () => { tile.status = 'ready'; this.redraw() }
    image.onerror = () => { tile.status = 'failed'; this.redraw() }
    image.src = `/api/map/imagery/${key}`
    return tile
  }

  private remove(key: string, { image, status }: TileImage) {
    image.onload = image.onerror = null
    if (status === 'loading') image.removeAttribute('src')
    this.cache.delete(key)
  }

  retry() {
    for (const [key, tile] of this.cache) if (tile.status === 'failed') this.remove(key, tile)
    this.redraw()
  }

  dispose() {
    for (const [key, tile] of this.cache) this.remove(key, tile)
  }
}
