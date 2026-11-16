import { useEffect, useState } from 'react'
import { Alert, Box, Button, Divider, Drawer, LinearProgress, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { locationLabel, readBoothApi } from './api'
import type { BoothDetail as Detail, BoothSummary, MapVacancy } from './api'
import { BoothImages, BoothLinks } from './BoothMedia'
import { useAuth } from '../auth/context'

export default function BoothDetail({ booth, initialDetail, vacancy, alternatives, onSelect, onClose }: {
  booth: BoothSummary | null
  initialDetail?: Detail | null
  vacancy?: MapVacancy | null
  alternatives?: BoothSummary[]
  onSelect?: (booth: BoothSummary) => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const userId = user?.id
  const [detail, setDetail] = useState<{ data: Detail; userId: string | undefined } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const id = booth?.id
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    void readBoothApi<Detail>(`/${id}`, controller.signal).then(result => {
      if (!controller.signal.aborted) { setDetail({ data: result, userId }); setError(null) }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        console.error('Booth detail failed:', reason)
        setError(reason instanceof Error ? reason.message : '详情加载失败')
      }
    })
    return () => controller.abort()
  }, [id, retry, userId])
  const loaded = detail && detail.data.id === id && detail.userId === userId ? detail.data : null
  const current = loaded ?? (initialDetail?.id === id ? initialDetail : null)
  return <Drawer anchor="right" open={!!booth || !!vacancy} onClose={onClose} slotProps={{ paper: { sx: { width: 760, maxWidth: '100vw' } } }}>
    {vacancy && !booth && <Stack spacing={2} sx={{ p: 3 }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="h5">未匹配社团的位置</Typography><Button onClick={onClose}>关闭</Button>
      </Stack>
      <Typography>{locationLabel(vacancy)} · C{vacancy.comiket} · {vacancy.weekday}曜日</Typography>
      <Alert severity="info">地图中存在此半摊位，但当前数据库中没有对应社团；这不代表官方确认的空摊位。</Alert>
      <Typography color="text.secondary">场馆：{vacancy.hall_group}<br />最后比对：{vacancy.checked_at}</Typography>
    </Stack>}
    {booth && <Stack spacing={2.5} sx={{ p: 3 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>{booth.circle_name}</Typography>
        <Button onClick={onClose}>关闭</Button>
      </Stack>
      {alternatives && alternatives.length > 1 && onSelect && <TextField select label="此位置的社团" size="small" value={booth.id}
        onChange={event => {
          const circle = alternatives.find(circle => circle.id === event.target.value)
          if (circle) onSelect(circle)
        }}>
        {alternatives.map(circle => <MenuItem key={circle.id} value={circle.id}>{circle.circle_name}</MenuItem>)}
      </TextField>}
      {error && <Alert severity="error" action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
      {!loaded && !error && <LinearProgress aria-label="加载社团详情" />}
      <Typography color="text.secondary">{booth.author_name || '未提供作者名'}</Typography>
      <BoothImages booth={current ?? booth} large />
      <BoothLinks booth={current ?? booth} />
      {current && <>
        <Divider />
        <Box component="dl" sx={{
          m: 0, display: 'grid',
          gridTemplateColumns: { xs: '100px minmax(0, 1fr)', sm: 'repeat(2, 100px minmax(0, 1fr))' },
          rowGap: 0.75, columnGap: 1.5, typography: 'body2',
          '& dt': { color: 'text.secondary' }, '& dd': { m: 0, overflowWrap: 'anywhere' },
        }}>
          {[
            ['参展记录 ID', current.id],
            ['社团名读音', current.circle_name_reading], ['位置', locationLabel(current)],
            ['日期', `${current.dayLabel}（${current.weekday}）`],
            ['ジャンル', `${current.genre || '—'}${current.genre_code ? ` (${current.genre_code})` : ''}`],
            ['Twitter ID', current.twitter_id], ['最后采集', current.last_crawled_at],
          ].map(([label, value]) => <Box key={label} sx={{ display: 'contents' }}>
            <Box component="dt">{label}</Box><Box component="dd">{value || '—'}</Box>
          </Box>)}
          {[
            ['補足説明', current.circle_appeal],
            ['タグ', current.tags], ['Memo', loaded?.memo],
          ].map(([label, value]) => <Box key={label} sx={{
            gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '100px minmax(0, 1fr)', columnGap: 1.5,
            mt: label === '補足説明' ? 2 : 0,
          }}>
            <Box component="dt">{label}</Box>
            <Box component="dd" sx={{ whiteSpace: 'pre-wrap' }}>{value || '—'}</Box>
          </Box>)}
        </Box>
        <Button component="a" href={current.source_url} target="_blank" rel="noopener noreferrer">查看 Web Catalog 原页面</Button>
      </>}
    </Stack>}
  </Drawer>
}
