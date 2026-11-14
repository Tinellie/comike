import { useEffect, useState } from 'react'
import { Alert, Box, Button, Divider, Drawer, LinearProgress, Stack, Typography } from '@mui/material'
import { locationLabel, readBoothApi } from './api'
import type { BoothDetail as Detail, BoothSummary } from './api'
import { BoothImages, BoothLinks } from './BoothMedia'

export default function BoothDetail({ booth, onClose }: { booth: BoothSummary | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const id = booth?.id
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    void readBoothApi<Detail>(`/${id}`, controller.signal).then(result => {
      if (!controller.signal.aborted) { setDetail(result); setError(null) }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        console.error('Booth detail failed:', reason)
        setError(reason instanceof Error ? reason.message : '详情加载失败')
      }
    })
    return () => controller.abort()
  }, [id, retry])
  const current = detail?.id === id ? detail : null
  return <Drawer anchor="right" open={!!booth} onClose={onClose} slotProps={{ paper: { sx: { width: 560, maxWidth: '100vw' } } }}>
    {booth && <Stack spacing={2.5} sx={{ p: 3 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>{booth.circle_name}</Typography>
        <Button onClick={onClose}>关闭</Button>
      </Stack>
      {error && <Alert severity="error" action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
      {!current && !error && <LinearProgress aria-label="加载社团详情" />}
      <Typography color="text.secondary">{booth.author_name || '未提供作者名'}</Typography>
      <BoothImages booth={current ?? booth} large />
      <BoothLinks booth={current ?? booth} />
      {current && <>
        <Divider />
        <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: '115px minmax(0, 1fr)', gap: 1.5, '& dt': { color: 'text.secondary' }, '& dd': { m: 0, overflowWrap: 'anywhere' } }}>
          {[
            ['参展记录 ID', current.id], ['活动 ID', current.event_id], ['Comiket', `C${current.comiket}`],
            ['社团名读音', current.circle_name_reading], ['位置', locationLabel(current)],
            ['日期', `${current.dayLabel}（${current.weekday}）`], ['场馆', current.hallGroup],
            ['ジャンル', current.genre], ['ジャンル编号', current.genre_code], ['社团 ID', current.circle_id],
            ['Pixiv ID', current.pixiv_id], ['Twitter ID', current.twitter_id], ['最后采集', current.last_crawled_at],
          ].map(([label, value]) => <Box key={label} sx={{ display: 'contents' }}>
            <Box component="dt">{label}</Box><Box component="dd">{value || '—'}</Box>
          </Box>)}
        </Box>
        {[
          ['補足説明 / サークルアピール', current.circle_appeal],
          ['タグ', current.tags], ['Memo（预留）', '暂无备注'],
        ].map(([label, value]) => <Box key={label}>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{label}</Typography>
          <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value || '—'}</Typography>
        </Box>)}
        <Button component="a" href={current.source_url} target="_blank" rel="noopener noreferrer">查看 Web Catalog 原页面</Button>
      </>}
    </Stack>}
  </Drawer>
}
