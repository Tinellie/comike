import { useEffect, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel,
  MenuItem, Stack, TextField, Typography,
} from '@mui/material'
import MapCanvas from '../preview/MapCanvas'
import { PreviewRepository, statusColors } from '../preview/data'
import type { PreviewPage } from '../preview/data'
import type { PreviewOptions } from '../preview/layers'

const islandTypeNames = {
  uppercase: '大写字母', lowercase: '小写字母', hiragana: '平假名', katakana: '片假名',
}

export default function Preview() {
  const [pages, setPages] = useState<PreviewPage[] | null>(null)
  const [pageNumber, setPageNumber] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [options, setOptions] = useState<PreviewOptions>({
    background: true, boxes: true, numbers: true, islands: true,
  })

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
              ['islands', 'Island 标记'],
            ] as const).map(([key, label]) => (
              <FormControlLabel
                key={key} label={label}
                control={<Checkbox checked={options[key]} disabled={key === 'islands' && page.islandMarkers === null} onChange={(_, checked) =>
                  setOptions(previous => ({ ...previous, [key]: checked }))} />}
              />
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {page.width} × {page.height} px · {page.booths.length} 个候选图格
            {page.islandMarkers !== null && ` · ${page.islandMarkers.length} 个 Island 标记`}
            {' · 放大后可滚动查看'}
          </Typography>
          {page.islandMarkers === null ? (
            <Alert severity="info">当前是旧版 Booth 结果，重新运行主识别脚本可加入 Island 标记。</Alert>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Island：紫色实线为已识别，橙色虚线待复核，红色虚线未识别。
              共 {page.islandMarkers.filter(marker => marker.status === 'needs_review').length} 个待复核，
              {page.islandMarkers.filter(marker => marker.status === 'unrecognized').length} 个未识别；
              重复标记分别保留，尚未分配 Booth 归属。
            </Typography>
          )}
          {page.islandInference && (
            <Typography variant="body2" color="text.secondary">
              步骤 2：页面编号类型
              {page.islandInference.type ? `为${islandTypeNames[page.islandInference.type]}` : '证据不足，未确定'}
              {' · 类型加权票占比 '}{Math.round(page.islandInference.confidence * 100)}%
              {' · 修正 '}{page.islandInference.outcomes.corrected ?? 0}
              {' 项，确认 '}{page.islandInference.outcomes.confirmed ?? 0}
              {' 项 · * 表示经过上下文修正/确认，仍有其他问题的标记保持待复核。'}
            </Typography>
          )}
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
