import { useEffect, useState } from 'react'
import { Alert, Box, Button, ButtonBase, CircularProgress, Modal, Typography } from '@mui/material'
import type { SocialImage } from './api'

function ImagePreview({ image, label, previewUrl }: { image: SocialImage; label: string; previewUrl: string | undefined }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!previewUrl) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    const load = async () => {
      const response = await fetch(previewUrl, {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      })
      if (!response.ok) {
        const body: { message?: string } = await response.json()
        throw new Error(body.message ?? `大图加载失败（HTTP ${response.status}）`)
      }
      const blob = await response.blob()
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      const decoded = new Image()
      decoded.src = objectUrl
      await decoded.decode()
      if (!controller.signal.aborted) setPreview(objectUrl)
    }
    void load().catch((reason: unknown) => {
      if (controller.signal.aborted) return
      console.error('Preview image failed:', image.id, reason)
      setError(reason instanceof Error ? reason.message : '大图加载失败')
    })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [previewUrl, image.id, retry])
  return <Box onClick={event => event.stopPropagation()} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', maxHeight: '95vh' }}>
    <Box component="img" src={preview ?? image.url} alt={`${label} ${image.id}`}
      sx={{ maxWidth: '95vw', maxHeight: '85vh', objectFit: 'contain' }} />
    {previewUrl && !preview && !error && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'white', p: 1 }}>
      <CircularProgress size={20} color="inherit" aria-label="加载大图" /><Typography variant="caption">加载大图中</Typography>
    </Box>}
    {error && <Alert severity="error" action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
  </Box>
}

export default function ImageGallery({ images, label, reserveSpace, previewBaseUrl }: {
  images: SocialImage[]; label: string; reserveSpace: boolean; previewBaseUrl?: string | undefined
}) {
  const [selected, setSelected] = useState<SocialImage | null>(null)
  const [loaded, setLoaded] = useState<Record<string, boolean>>({})
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const expanded = images.length > 0 && (reserveSpace || images.some(image => loaded[image.url]))
  return <>
    {!expanded && images.some(image => failed[image.url]) && <Alert severity="error"
      action={<Button onClick={() => setFailed({})}>重试</Button>}>图片加载失败</Alert>}
    <Box aria-label={label} aria-hidden={!expanded} inert={!expanded}
      sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 1, height: expanded ? 'auto' : 0, overflow: expanded ? undefined : 'hidden' }}>
      {Array.from({ length: 10 }, (_, index) => {
        const image = images[index]
        return image ? <ButtonBase key={image.id} aria-label={`展开 ${label} ${image.id}`}
          onClick={() => {
            if (failed[image.url]) { setFailed(value => ({ ...value, [image.url]: false })); setLoaded(value => ({ ...value, [image.url]: false })) }
            else if (loaded[image.url]) setSelected(image)
          }} sx={{ aspectRatio: '1', minWidth: 0, borderRadius: 0.5, overflow: 'hidden', position: 'relative' }}>
          {failed[image.url] ? <Typography variant="caption" color="error">加载失败，点击重试</Typography> : <>
            {!loaded[image.url] && <CircularProgress size={24} aria-label={`加载 ${label} ${image.id}`} sx={{ position: 'absolute' }} />}
            <Box component="img" src={image.url} alt={`${label} ${image.id}`}
              onLoad={() => setLoaded(value => ({ ...value, [image.url]: true }))}
              onError={() => { console.error('Gallery image failed:', image.id); setFailed(value => ({ ...value, [image.url]: true })) }}
              sx={{ width: '100%', height: '100%', objectFit: 'cover', visibility: loaded[image.url] ? 'visible' : 'hidden' }} />
          </>}
        </ButtonBase> : <Box key={`empty-${index}`} sx={{ aspectRatio: '1' }} />
      })}
    </Box>
    <Modal open={!!selected} onClose={() => setSelected(null)}
      slotProps={{ backdrop: { sx: { bgcolor: 'rgba(0, 0, 0, 0.8)' } } }}>
      <Box role="dialog" aria-label="图片预览" tabIndex={-1} onClick={() => setSelected(null)}
        sx={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', outline: 0 }}>
        {selected && <ImagePreview key={selected.id} image={selected} label={label}
          previewUrl={previewBaseUrl ? `${previewBaseUrl}/${selected.id}` : undefined} />}
      </Box>
    </Modal>
  </>
}
