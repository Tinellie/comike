import { useEffect, useState } from 'react'
import { Alert, Box, Button, LinearProgress, Stack, Typography } from '@mui/material'
import ImageGallery from './ImageGallery'
import { requestSocial } from './api'
import type { CachedSocialGallery, SocialGallery } from './api'
import { useAuth } from '../auth/context'

export default function SocialImages({ boothId, provider }: { boothId: string; provider: 'pixiv' | 'twitter' }) {
  const { user } = useAuth()
  const userId = user?.id
  const label = provider === 'pixiv' ? 'Pixiv' : 'Twitter'
  const [gallery, setGallery] = useState<(SocialGallery & { hasLocalImages: boolean }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const requestKey = JSON.stringify([provider, boothId, userId, retry])
  const syncing = !!userId && refreshing === requestKey

  useEffect(() => {
    const controller = new AbortController()
    const display = (result: SocialGallery, local: boolean) => setGallery(current => {
      const hasLocalImages = !!current?.hasLocalImages || (local ? result.images.length > 0 : result.images.length > result.missingCount)
      return current && current.hasLocalImages === hasLocalImages && current.images.length === result.images.length
        && current.images.every((image, index) => image.id === result.images[index]?.id && image.url === result.images[index]?.url)
        ? current : { ...result, hasLocalImages }
    })
    const failed = (reason: unknown) => {
      if (controller.signal.aborted) return
      console.error(`${provider} gallery failed:`, reason)
      setError(reason instanceof Error ? reason.message : '图片读取失败')
    }
    const load = async () => {
      const cached = await requestSocial<CachedSocialGallery>(provider, `/booths/${boothId}`, controller.signal)
      if (controller.signal.aborted) return
      display(cached, true)
      setError(null)
      if (!userId) return
      if (cached.refreshNeeded) setRefreshing(requestKey)
      const result = await requestSocial<SocialGallery>(provider, `/live/booths/${boothId}`, controller.signal)
      if (controller.signal.aborted) return
      display(result, false)
    }
    void load().catch(failed).finally(() => {
      if (!controller.signal.aborted) setRefreshing(current => current === requestKey ? null : current)
    })
    return () => controller.abort()
  }, [boothId, provider, userId, retry, requestKey])

  return <Stack>
    <Typography variant="subtitle2">{label}</Typography>
    <Box sx={{ height: 18, display: 'flex', alignItems: 'center' }}>
      {syncing && <LinearProgress aria-label={`同步 ${label} 图片列表`} sx={{ height: 2, width: '100%' }} />}
    </Box>
    {error && <Alert severity="error" sx={{ mb: 1 }} action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
    {gallery && <ImageGallery images={gallery.images} label={`${label} 作品`} reserveSpace={gallery.hasLocalImages}
      previewBaseUrl={userId ? `/api/social/${provider}/preview/${boothId}` : undefined} />}
  </Stack>
}
