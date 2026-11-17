import { useEffect, useState } from 'react'
import { Alert, Button, LinearProgress, Stack, Typography } from '@mui/material'
import ImageGallery from './ImageGallery'
import { requestPixiv } from './api'
import type { PixivGallery } from './api'

export default function PixivImages({ boothId }: { boothId: string }) {
  const [gallery, setGallery] = useState<PixivGallery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void requestPixiv<PixivGallery>(`/booths/${boothId}`, controller.signal).then(result => {
      if (!controller.signal.aborted) { setGallery(result); setError(null) }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        console.error('Pixiv gallery failed:', reason)
        setError(reason instanceof Error ? reason.message : 'Pixiv 图片读取失败')
      }
    })
    return () => controller.abort()
  }, [boothId, retry])
  return <Stack spacing={1}>
    <Typography variant="subtitle2">Pixiv</Typography>
    {error && <Alert severity="error" action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
    {!gallery && !error && <LinearProgress aria-label="加载 Pixiv 图片" />}
    {!!gallery?.missingCount && <Alert severity="warning">本地缺失 {gallery.missingCount} 张图片，请使用刷新收藏图片菜单修复（仍受 1 小时间隔限制）。</Alert>}
    {gallery && (gallery.images.length
      ? <ImageGallery images={gallery.images} label="Pixiv 作品" />
      : <Typography variant="body2" color="text.secondary">{gallery.updatedAt ? '暂无可见作品图片' : '尚未采集图片，请使用列表右上角的收藏图片菜单。'}</Typography>)}
  </Stack>
}
