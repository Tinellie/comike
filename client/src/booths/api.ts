export interface BoothSummary {
  id: string
  event_id: string
  comiket: number
  circle_name: string
  circle_name_reading: string | null
  author_name: string | null
  weekday: string
  hall: string
  hallGroup: string
  island_code: string
  booth_number: string
  booth_suffix: string | null
  genre: string | null
  tags: string | null
  circle_id: string | null
  pixiv_id: string | null
  twitter_id: string | null
  images: string[]
  imageUrls: string[]
  dayLabel: string
  dayOrder: number
}

export interface BoothDetail extends BoothSummary {
  colour?: string | null
  memo?: string | null
  genre_code: string | null
  circle_appeal: string | null
  source_url: string
  last_crawled_at: string
}

export interface BoothListItem extends BoothSummary {
  colour: string | null
  memo: string | null
}

export interface BoothOptions {
  event: { eventId: string; comiket: number } | null
  events: { eventId: string; comiket: number }[]
  days: { weekday: string; order: number; label: string }[]
  halls: string[]
  genres: (string | null)[]
  colours: string[]
  warnings: string[]
}

export type BoothDays = Pick<BoothOptions, 'event' | 'days' | 'warnings'>

export interface MapBoothData {
  merged: Record<string, string[]>
  vacancies: Record<string, string[]>
  vacancyRegions: { hallGroup: string; rectangles: MapRectangle[] }[]
  genres: { key: string; name: string | null; code: string | null; color: string; count: number }[]
  genreRegions: { hallGroup: string; genreKey: string; rectangles: MapRectangle[] }[]
  vacancyReady: boolean
  genreReady: boolean
}

export interface MapRectangle { x: number; y: number; width: number; height: number }

export interface MapFavorite {
  boothId: string
  hallGroup: string
  island: string
  number: string
  suffix: string | null
  colour: string
}

export interface BoothPage {
  items: BoothListItem[]
  total: number
  nextOffset: number | null
}

export interface MapVacancy {
  event_id: string
  comiket: number
  weekday: string
  hall: string
  hall_group: string
  island_code: string
  booth_number: string
  booth_suffix: string
  checked_at: string
}

export interface MapBoothLocation {
  circles: BoothDetail[]
  vacancy: MapVacancy | null
}

export async function readBoothApi<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/booths${path}`, {
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  })
  if (!response.ok) {
    const body: { message?: string } = await response.json()
    throw new Error(body.message ?? `读取失败（HTTP ${response.status}）`)
  }
  return response.json()
}

export async function saveBoothFavorite(id: string, patch: { colour?: string | null; memo?: string }) {
  const response = await fetch(`/api/booths/${encodeURIComponent(id)}/favorite`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch), signal: AbortSignal.timeout(20_000),
  })
  const result: { colour: string | null; memo: string; message?: string } = await response.json()
  if (!response.ok) throw new Error(result.message ?? `保存失败（HTTP ${response.status}）`)
  return result
}

export function locationLabel(booth: Pick<BoothSummary, 'hall' | 'island_code' | 'booth_number' | 'booth_suffix'>) {
  return `${booth.hall}${booth.island_code}${booth.booth_number}${booth.booth_suffix ?? ''}`
}
