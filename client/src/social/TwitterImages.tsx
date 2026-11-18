import { useEffect, useState } from 'react'
import { Alert, Button, LinearProgress, Stack, Typography } from '@mui/material'
import ImageGallery from './ImageGallery'
import { requestSocial } from './api'
import type { SocialImage } from './api'

export default function TwitterImages({ boothId }: { boothId: string }) {
  const [gallery, setGallery] = useState<{ images: SocialImage[]; missingCount: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void requestSocial<{ images: SocialImage[]; missingCount: number }>('twitter', `/booths/${boothId}`, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setGallery(result); setError(null) } })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          console.error('Twitter gallery failed:', reason)
          setError(reason instanceof Error ? reason.message : 'Twitter 图片读取失败')
        }
      })
    return () => controller.abort()
  }, [boothId, retry])
  return <Stack spacing={1}>
    <Typography variant="subtitle2">Twitter</Typography>
    {error && <Alert severity="error" action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
    {!gallery && !error && <LinearProgress aria-label="读取 Twitter 本地图片" />}
    {!!gallery?.missingCount && <Alert severity="warning">本地缺失 {gallery.missingCount} 张图片，请使用刷新 Twitter 图片菜单修复。</Alert>}
    {gallery && <ImageGallery images={gallery.images} label="Twitter 作品" />}
  </Stack>
}
