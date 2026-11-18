import { useState } from 'react'
import { Alert, Box, Button, ButtonBase, CircularProgress, Modal, Typography } from '@mui/material'
import type { SocialImage } from './api'

export default function ImageGallery({ images, label, reserveSpace }: { images: SocialImage[]; label: string; reserveSpace: boolean }) {
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
        {selected && <Box component="img" src={selected.url} alt={`${label} ${selected.id}`}
          onClick={event => event.stopPropagation()}
          sx={{ maxWidth: '95vw', maxHeight: '95vh', objectFit: 'contain' }} />}
      </Box>
    </Modal>
  </>
}
