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
    background: true, boxes: true, blockFrames: true, numbers: true, islands: true,
    groups: true, gaps: true, halfBooths: true, selectedIsland: null,
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
            ] as const).map(([key, label]) => (
              <FormControlLabel
                key={key} label={label}
                control={<Checkbox checked={options[key]} disabled={
                  (key === 'islands' && page.islandMarkers === null)
                  || (key === 'blockFrames' && page.blocks === null)
                  || (key === 'halfBooths' && page.halfBooths === null)
                  || ((key === 'groups' || key === 'gaps') && page.islandAssignment === null)
                } onChange={(_, checked) =>
                  setOptions(previous => ({ ...previous, [key]: checked }))} />}
              />
            ))}
          </Stack>
          {page.venue && (
            <Typography variant="body2" color={page.venue.status === 'recognized' ? 'text.secondary' : 'warning.main'}>
              场馆：{page.venue.label ?? (page.venue.status === 'not_run' ? '未执行 OCR' : '未识别')}
              {page.venue.status === 'needs_review' && '（待复核）'}
              {page.venue.recognitionScore !== null && ` · OCR 置信度 ${Math.round(page.venue.recognitionScore * 100)}%`}
            </Typography>
          )}
          {page.halfBooths && (
            <Typography variant="body2" color="text.secondary">
              步骤 6：{page.halfBooths.length} 个 half-booth；
              {page.halfBooths.filter(h => h.status === 'needs_review').length / 2} 个原 Booth 的分割建议待复核。
              内部 Block 两端采用平行切线，端部外半：相邻编号小取 a，大取 b；壁摊不改变端部切线。
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {page.width} × {page.height} px · {page.booths.length} 个{page.islandAssignment ? ' Booth' : '候选图格'}
            {page.islandMarkers !== null && ` · ${page.islandMarkers.length} 个 Island 标记`}
            {page.blocks !== null && ` · ${page.blocks.length} 个 Block`}
            {' · 放大后可滚动查看'}
          </Typography>
          {page.islandMarkers === null ? (
            <Alert severity="info">当前是旧版 Booth 结果，重新运行主识别脚本可加入 Island 标记。</Alert>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Island：紫色实线为已识别，橙色虚线待复核，红色虚线未识别。
              共 {page.islandMarkers.filter(marker => marker.status === 'needs_review').length} 个待复核，
              {page.islandMarkers.filter(marker => marker.status === 'unrecognized').length} 个未识别；
              重复标记分别保留{page.islandAssignment ? '。' : '，尚未分配 Booth 归属。'}
            </Typography>
          )}
          {page.islandAssignment && (
            <Typography variant="body2" color="text.secondary">
              {page.blocks === null ? '步骤 3' : '步骤 4'}：{page.booths.length} 个 Booth 已全部划分至 {page.islandAssignment.islands.length} 个 Island，
              同岛编号不重复、同一 {page.blocks === null ? '相接组件' : 'Block'} 不拆分。
              排除 {page.islandAssignment.excludedCount} 个未识别候选；
              {page.islandAssignment.reviewCount} 个归属建议待复核；
              共 {page.islandAssignment.gapCount} 处缺号，橙色引线在格外标注缺号后的编号，不修改 Booth。
            </Typography>
          )}
          {page.blocks !== null && (
            <Typography variant="body2" color="text.secondary">
              步骤 2：仅合并边框像素直接接触的 Booth，不跨过道；先绘制 Block 外轮廓，再绘制去重的内部横竖分割线。
              蓝色虚线为额外外扩 6 px 的 Block 包围框，可独立关闭。
            </Typography>
          )}
          {page.markerAlignment && (
            <Typography variant="body2" color="text.secondary">
              步骤 5：Island 标记仅使用中心点；
              {page.markerAlignment.status === 'centers_only' ? '尚无 Island 归属，未移动中心点。' : (
                <> {page.markerAlignment.aligned} 个标记参与附近行列对齐，
                  {page.markerAlignment.centered} 个尝试后可按 Island 中点居中。
                  壁摊只与附近同向、同侧壁摊标记对齐，不向 Island 中心移动。</>
              )}
            </Typography>
          )}
          {page.islandInference && (
            <Typography variant="body2" color="text.secondary">
              {page.blocks === null ? '步骤 2' : '步骤 3'}：页面编号类型
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
