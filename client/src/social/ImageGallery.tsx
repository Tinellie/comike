import { useState } from 'react'
import { Box, ButtonBase, Modal } from '@mui/material'
import type { SocialImage } from './api'

export default function ImageGallery({ images, label }: { images: SocialImage[]; label: string }) {
  const [selected, setSelected] = useState<SocialImage | null>(null)
  return <>
    <Box aria-label={label} sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 1 }}>
      {Array.from({ length: 10 }, (_, index) => {
        const image = images[index]
        return image ? <ButtonBase key={image.id} aria-label={`展开 ${label} ${image.id}`}
          onClick={() => setSelected(image)} sx={{ aspectRatio: '1', minWidth: 0, borderRadius: 0.5, overflow: 'hidden' }}>
          <Box component="img" src={image.url} alt={`${label} ${image.id}`} loading="lazy"
            sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
