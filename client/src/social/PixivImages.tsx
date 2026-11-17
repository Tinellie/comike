import { useEffect, useState } from 'react'
import { Alert, Button, LinearProgress, Stack, Typography } from '@mui/material'
import ImageGallery from './ImageGallery'
import { requestPixiv } from './api'
import type { PixivGallery } from './api'
import { useAuth } from '../auth/context'

export default function PixivImages({ boothId }: { boothId: string }) {
  const { user } = useAuth()
  const [gallery, setGallery] = useState<PixivGallery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!user) return
    const controller = new AbortController()
    void requestPixiv<PixivGallery>(`/live/booths/${boothId}`, controller.signal).then(result => {
      if (!controller.signal.aborted) { setGallery(result); setError(null) }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        console.error('Pixiv gallery failed:', reason)
        setError(reason instanceof Error ? reason.message : 'Pixiv 图片读取失败')
      }
    })
    return () => controller.abort()
  }, [boothId, retry, user])
  return <Stack spacing={1}>
    <Typography variant="subtitle2">Pixiv</Typography>
    {!user && <Typography variant="body2" color="text.secondary">登录后可即时加载 Pixiv 缩略图。</Typography>}
    {error && <Alert severity="error" action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
    {user && !gallery && !error && <LinearProgress aria-label="加载 Pixiv 图片" />}
    {user && gallery && (gallery.images.length
      ? <ImageGallery images={gallery.images} label="Pixiv 作品" />
      : <Typography variant="body2" color="text.secondary">暂无可见作品图片</Typography>)}
  </Stack>
}
