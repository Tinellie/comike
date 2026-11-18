import type { ImageList, ImageListStore, ImageProvider } from '../src/social/imageLists.js'

export class MemoryImageListStore implements ImageListStore {
  private readonly rows = new Map<string, ImageList>()
  async read(provider: ImageProvider, artistId: string) {
    return structuredClone(this.rows.get(`${provider}:${artistId}`) ?? null)
  }
  async save(provider: ImageProvider, artistId: string, list: ImageList) {
    this.rows.set(`${provider}:${artistId}`, structuredClone(list))
  }
}
