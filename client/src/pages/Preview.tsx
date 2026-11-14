import { useEffect, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel,
  MenuItem, Stack, TextField, Typography,
} from '@mui/material'
import MapCanvas from '../preview/MapCanvas'
import { PreviewRepository, statusColors } from '../preview/data'
import type { PreviewPage } from '../preview/data'
import type { PreviewOptions } from '../preview/layers'

interface Generation {
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  message?: string
}

export default function Preview() {
  const [generation, setGeneration] = useState<Generation>({ status: 'idle' })
  const [starting, setStarting] = useState(false)
  const [pages, setPages] = useState<PreviewPage[] | null>(null)
  const [pageNumber, setPageNumber] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [options, setOptions] = useState<PreviewOptions>({
    background: true, boxes: true, blockFrames: true, numbers: true, islands: true,
    groups: true, gaps: true, halfBooths: true, hallOutline: true, hallLabels: true, selectedIsland: null,
  })

  useEffect(() => {
    if (generation.status !== 'idle' && generation.status !== 'running') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const response = await fetch('/api/preview/regenerate', { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error(`生成状态加载失败（HTTP ${response.status}）`)
        const result: Generation = await response.json()
        if (controller.signal.aborted) return
        setGeneration(result)
        if (result.status === 'running') timer = setTimeout(() => { void poll() }, 2000)
        if (result.status === 'succeeded') {
          setError(null)
          setOptions(previous => ({ ...previous, selectedIsland: null }))
          setAttempt(value => value + 1)
        }
      } catch (reason) {
        if (controller.signal.aborted) return
        console.error('Preview generation status failed:', reason)
        setGeneration({ status: 'failed', message: reason instanceof Error ? reason.message : '生成状态加载失败' })
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [generation.status])

  async function regenerate() {
    setStarting(true)
    try {
      const response = await fetch('/api/preview/regenerate', { method: 'POST' })
      const result: Generation = await response.json()
      if (!response.ok && response.status !== 409) throw new Error(result.message ?? `重新生成失败（HTTP ${response.status}）`)
      setGeneration({ status: 'running' })
    } catch (reason) {
      console.error('Preview regeneration failed:', reason)
      setGeneration({ status: 'failed', message: reason instanceof Error ? reason.message : '重新生成失败' })
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void new PreviewRepository().load(controller.signal).then(result => {
      if (active) {
        setPages(result)
        setPageNumber(result[0].page)
      }
    }).catch((reason: unknown) => {
      if (active) {
        console.error('Preview data loading failed:', reason)
        setError(reason instanceof Error ? reason.message : '识别结果加载失败')
      }
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [attempt])

  const page = pages?.find(item => item.page === pageNumber)

  return (
    <Stack spacing={2} sx={{ p: { xs: 2, md: 3 } }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="h5" component="h1">地图预览</Typography>
        <Button variant="contained" disabled={starting || generation.status === 'running'} onClick={() => { void regenerate() }}>
          {starting || generation.status === 'running' ? '正在重新生成…' : '重新生成'}
        </Button>
      </Stack>
      {generation.status === 'running' && <Alert severity="info">正在从 PDF 重新生成全部地图数据，可能需要数分钟。完成后自动刷新。</Alert>}
      {generation.status === 'failed' && <Alert severity="error">{generation.message}</Alert>}
      {generation.status === 'succeeded' && <Alert severity="success">地图数据已重新生成。</Alert>}
      {error && (
        <Alert severity="error" action={<Button color="inherit" onClick={() => {
          setError(null)
          setAttempt(value => value + 1)
        }}>重试</Button>}>{error}</Alert>
      )}
      {!pages && !error && <CircularProgress aria-label="加载识别结果" />}
      {pages && page && (
        <>
          <Stack direction="row" useFlexGap spacing={2} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <TextField
              select label="页数" value={page.page} size="small" sx={{ minWidth: 180 }}
              onChange={event => {
                setPageNumber(Number(event.target.value))
                setOptions(previous => ({ ...previous, selectedIsland: null }))
              }}
            >
              {pages.map(item => (
                <MenuItem key={item.page} value={item.page}>
                  第 {item.page} 页{item.venue?.label ? ` · ${item.venue.label}` : ''}
                </MenuItem>
              ))}
            </TextField>
            {page.islandAssignment && (
              <TextField
                select label="Island 分组" value={options.selectedIsland ?? 'all'} size="small" sx={{ minWidth: 180 }}
                onChange={event => setOptions(previous => ({
                  ...previous, selectedIsland: event.target.value === 'all' ? null : event.target.value,
                }))}
              >
                <MenuItem value="all">全部 Island</MenuItem>
                {page.islandAssignment.islands.map(island => (
                  <MenuItem key={island.id} value={island.id}>
                    {island.label ?? '编号待确认'} · {island.boothIds.length} 个 Booth
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              select label="缩放" value={zoom} size="small" sx={{ minWidth: 150 }}
              onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}
            >
              <MenuItem value="fit">适应宽度</MenuItem>
              {[0.5, 1, 1.5, 2].map(value => <MenuItem key={value} value={value}>{value * 100}%</MenuItem>)}
            </TextField>
            {([
              ['background', '原图背景'], ['boxes', page.blocks === null ? '图格边框' : 'Block 边框'], ['numbers', '识别编号'],
              ['blockFrames', 'Block 外扩框'],
              ['islands', 'Island 标记'],
              ['groups', '分组着色'], ['gaps', '缺号断点'],
              ['halfBooths', 'Half-booth a/b'],
              ['hallOutline', 'Hall 边框'],
              ['hallLabels', '场馆标签'],
            ] as const).map(([key, label]) => (
              <FormControlLabel
                key={key} label={label}
                control={<Checkbox checked={options[key]} disabled={
                  (key === 'islands' && page.islandMarkers === null)
                  || (key === 'blockFrames' && page.blocks === null)
                  || (key === 'halfBooths' && page.halfBooths === null)
                  || (key === 'hallOutline' && !page.hallOutline)
                  || (key === 'hallLabels' && !page.hallLabels?.length)
                  || ((key === 'groups' || key === 'gaps') && page.islandAssignment === null)
                } onChange={(_, checked) =>
                  setOptions(previous => ({ ...previous, [key]: checked }))} />}
              />
            ))}
          </Stack>
          <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {([
              ['recognized', '已识别'], ['needs_review', '待复核'],
              ['unrecognized', '未识别'], ['not_run', '未执行 OCR'],
            ] as const).map(([status, label]) => (
              <Box key={status} component="span" sx={{ color: statusColors[status], fontSize: 13 }}>
                {label}
              </Box>
            ))}
          </Stack>
          <MapCanvas key={`${attempt}-${page.page}`} page={page} options={options} zoom={zoom} />
        </>
      )}
    </Stack>
  )
}
