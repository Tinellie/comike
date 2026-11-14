import type { Booth } from '../db/schema.js'

export type JobStatus = 'idle' | 'listing' | 'details' | 'waiting_login' | 'stopping' | 'interrupted' | 'completed' | 'failed' | 'resetting'

export interface CrawlJob {
  id: string
  status: JobStatus
  action: string
  ids: string[]
  completedIds: string[]
  failures: Record<string, string>
  listComplete: boolean
  eventId: string | null
  comiket: number | null
  sample: Booth | null
  startedAt: string
  updatedAt: string
}

export interface CrawlStatus {
  id: string | null
  status: JobStatus
  action: string
  total: number
  processed: number
  succeeded: number
  failed: number
  listComplete: boolean
  comiket: number | null
  sample: Booth | null
  errors: { id: string; message: string }[]
  listCache: { total: number; completedAt: string; comiket: number | null } | null
  login: { open: boolean; authenticated: boolean; width: number; height: number; opening?: boolean; error?: string | null }
}

export interface CircleListCache {
  ids: string[]
  eventId: string | null
  comiket: number | null
  completedAt: string
}

export interface JobRepository {
  load(): Promise<CrawlJob | null>
  save(job: CrawlJob): Promise<void>
  saveBooth(booth: Booth): Promise<void>
  check(): Promise<void>
  loadList(): Promise<CircleListCache | null>
  saveList(cache: CircleListCache): Promise<void>
  resetRecords(): Promise<number>
  savedBooths(ids: string[]): Promise<{
    records: { id: string; event_id: string; comiket: number }[]
    sample: Booth | null
  }>
}
