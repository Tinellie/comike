export interface SocialImage { id: string; url: string }
export interface PixivGallery { pixivId: string | null; updatedAt: string | null; images: SocialImage[]; missingCount: number }
export interface PixivJobStatus {
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  total: number
  completed: number
  updated: number
  skipped: number
  failed: number
  message: string | null
  busy: boolean
  warning: string | null
  retry: { attempts: number; retryAt: number | null } | null
}

export async function requestPixiv<T>(path: string, signal: AbortSignal, mode?: 'refresh' | 'missing'): Promise<T> {
  return requestSocial<T>('pixiv', path, signal, mode)
}

export async function requestSocial<T>(provider: 'pixiv' | 'twitter', path: string, signal: AbortSignal, mode?: 'refresh' | 'missing'): Promise<T> {
  const response = await fetch(`/api/social/${provider}${path}`, {
    method: mode ? 'POST' : 'GET', cache: 'no-store',
    headers: mode ? { 'Content-Type': 'application/json' } : undefined,
    body: mode ? JSON.stringify({ mode }) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  })
  if (!response.ok) {
    const body: { message?: string } = await response.json()
    throw new Error(body.message ?? `${provider} 图片请求失败（HTTP ${response.status}）`)
  }
  return response.json()
}
