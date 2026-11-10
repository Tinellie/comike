import { useEffect, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel,
  MenuItem, Stack, TextField, Typography,
} from '@mui/material'
import MapCanvas from '../preview/MapCanvas'
import { PreviewRepository, statusColors } from '../preview/data'
import type { PreviewPage } from '../preview/data'
import type { PreviewOptions } from '../preview/layers'

export default function Preview() {
  const [pages, setPages] = useState<PreviewPage[] | null>(null)
  const [pageNumber, setPageNumber] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [options, setOptions] = useState<PreviewOptions>({ background: true, boxes: true, numbers: true })

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
      <Typography variant="h5" component="h1">地图预览</Typography>
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
              onChange={event => setPageNumber(Number(event.target.value))}
            >
              {pages.map(item => (
                <MenuItem key={item.page} value={item.page}>第 {item.page} 页</MenuItem>
              ))}
            </TextField>
            <TextField
              select label="缩放" value={zoom} size="small" sx={{ minWidth: 150 }}
              onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}
            >
              <MenuItem value="fit">适应宽度</MenuItem>
              {[0.5, 1, 1.5, 2].map(value => <MenuItem key={value} value={value}>{value * 100}%</MenuItem>)}
            </TextField>
            {([
              ['background', '原图背景'], ['boxes', '图格边框'], ['numbers', '识别编号'],
            ] as const).map(([key, label]) => (
              <FormControlLabel
                key={key} label={label}
                control={<Checkbox checked={options[key]} onChange={(_, checked) =>
                  setOptions(previous => ({ ...previous, [key]: checked }))} />}
              />
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {page.width} × {page.height} px · {page.booths.length} 个候选图格 · 放大后可滚动查看
          </Typography>
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
          <MapCanvas key={page.page} page={page} options={options} zoom={zoom} />
        </>
      )}
    </Stack>
  )
}
