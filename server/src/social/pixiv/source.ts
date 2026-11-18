export const PIXIV_IMAGE_LIMIT = 10
export class PixivAccessError extends Error {}
export function validPixivId(value: string) { return /^[1-9]\d{0,31}$/.test(value) }
export function newestFirst(ids: string[]) {
  return [...new Set(ids)].sort((a, b) => BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0)
}

export interface PixivSource {
  latest(pixivId: string, signal: AbortSignal): Promise<string[]>
  image(pixivId: string, imageId: string, signal: AbortSignal): Promise<{ body: Buffer; extension: string }>
  close?(): Promise<void>
  warning?(): string | null
  retryStatus?(): { attempts: number; retryAt: number | null } | null
  latestImages(pixivId: string, signal: AbortSignal): Promise<{ id: string; url: string }[]>
  download?(url: string, signal: AbortSignal): Promise<{ body: Buffer; extension: string }>
}
