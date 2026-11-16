import { useState } from 'react'
import { Box, IconButton, Tooltip } from '@mui/material'
import type { BoothSummary } from './api'

function BoothImage({ url, name, large }: { url: string; name: string; large: boolean }) {
  const [failed, setFailed] = useState(false)
  return failed ? <Box sx={{ width: large ? 200 : '50%', p: large ? 2 : 0.5, maxHeight: large ? undefined : 112, overflowY: 'auto', color: 'error.main', fontSize: 12, overflowWrap: 'anywhere' }}>
    图片加载失败：{name}
  </Box> : <Box component="img" src={url} alt={name} loading="lazy" decoding="async"
    onError={() => setFailed(true)}
    sx={{ width: 'auto', maxWidth: large ? 'min(200px, calc(50% - 4px))' : '50%', height: large ? 'auto' : 112, maxHeight: large ? 200 : undefined, objectFit: 'contain', display: 'block' }} />
}

export function BoothImages({ booth, large = false }: { booth: BoothSummary; large?: boolean }) {
  return <Box sx={{ width: '100%', minHeight: large ? 76 : 112, display: 'flex', flexWrap: 'wrap', gap: large ? 1 : 0, alignItems: 'center', justifyContent: 'center' }}>
    {booth.imageUrls.length
      ? booth.imageUrls.map((url, index) => <BoothImage key={url} url={url} name={`${booth.circle_name} 图片 ${index + 1}`} large={large} />)
      : <Box sx={{ color: 'text.disabled', fontSize: 12 }}>暂无图片</Box>}
  </Box>
}

export function BoothLinks({ booth }: { booth: BoothSummary }) {
  const links = [
    { key: 'circlems', label: 'Circle.ms', href: booth.circle_id ? `https://portal.circle.ms/Circle/Index/${encodeURIComponent(booth.circle_id)}` : null },
    { key: 'pixiv', label: 'Pixiv', href: booth.pixiv_id ? `https://www.pixiv.net/users/${encodeURIComponent(booth.pixiv_id)}` : null },
    { key: 'twitter', label: 'Twitter / X', href: booth.twitter_id ? `https://x.com/${encodeURIComponent(booth.twitter_id)}/media?filter=photo` : null },
  ]
  return <Box sx={{ display: 'flex', gap: 0.75 }} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    {links.map(link => {
      const icon = <Box component="img" src={`/icons/${link.key}.png`} alt="" sx={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover', ...(link.href ? {} : { filter: 'grayscale(1)', opacity: 0.25 }) }} />
      const sx = { width: 36, height: 36, p: 0, flexShrink: 0, borderRadius: 2, overflow: 'hidden', bgcolor: 'action.hover' }
      return <Tooltip key={link.key} title={link.href ? link.label : `${link.label}：未提供`}>
        {link.href
          ? <IconButton component="a" href={link.href} target="_blank" rel="noopener noreferrer" aria-label={link.label} sx={sx}>{icon}</IconButton>
          : <Box component="span" sx={{ display: 'inline-flex' }}><IconButton disabled aria-label={`${link.label}（未提供）`} sx={sx}>{icon}</IconButton></Box>}
      </Tooltip>
    })}
  </Box>
}
