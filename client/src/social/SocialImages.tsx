import { useEffect, useState } from 'react'
import { Alert, Box, Button, LinearProgress, Stack, Typography } from '@mui/material'
import ImageGallery from './ImageGallery'
import { requestSocial } from './api'
import type { SocialGallery } from './api'
import { useAuth } from '../auth/context'

export default function SocialImages({ boothId, provider }: { boothId: string; provider: 'pixiv' | 'twitter' }) {
  const { user } = useAuth()
  const userId = user?.id
  const label = provider === 'pixiv' ? 'Pixiv' : 'Twitter'
  const [gallery, setGallery] = useState<(SocialGallery & { hasLocalImages: boolean }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [finished, setFinished] = useState<string | null>(null)
  const requestKey = JSON.stringify([provider, boothId, userId, retry])
  const syncing = !!userId && finished !== requestKey

  useEffect(() => {
    const controller = new AbortController()
    let synchronized = false
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
    void requestSocial<SocialGallery>(provider, `/booths/${boothId}`, controller.signal)
      .then(result => { if (!controller.signal.aborted && !synchronized) display(result, true) })
      .catch((reason: unknown) => { if (!synchronized) failed(reason) })
    if (userId) {
      void requestSocial<SocialGallery>(provider, `/live/booths/${boothId}`, controller.signal)
        .then(result => {
          if (controller.signal.aborted) return
          synchronized = true
          display(result, false)
          setError(null)
        })
        .catch(failed)
        .finally(() => { if (!controller.signal.aborted) setFinished(requestKey) })
    }
    return () => controller.abort()
  }, [boothId, provider, userId, retry, requestKey])

  return <Stack>
    <Typography variant="subtitle2">{label}</Typography>
    <Box sx={{ height: 18, display: 'flex', alignItems: 'center' }}>
      {(syncing || (!gallery && !error)) && <LinearProgress aria-label={`同步 ${label} 图片列表`} sx={{ height: 2, width: '100%' }} />}
    </Box>
    {error && <Alert severity="error" sx={{ mb: 1 }} action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
    {gallery && <ImageGallery images={gallery.images} label={`${label} 作品`} reserveSpace={gallery.hasLocalImages} />}
  </Stack>
}
