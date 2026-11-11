import { useState } from 'react'
import { Button, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material'
import type { HallDisplay } from './HallMapLayer'
import type { HallPlacement, HallTransforms, MapHall } from './halls'

function NumberControl({ label, value, minimum, maximum, onChange }: {
  label: string; value: number; minimum: number; maximum: number; onChange: (value: number) => void
}) {
  const [edit, setEdit] = useState({ source: value, draft: String(value) })
  const draft = edit.source === value ? edit.draft : String(value)
  const parsed = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
  return (
    <TextField
      label={label} type="number" size="small" value={draft} error={!valid} required
      helperText={!valid ? `${minimum}–${maximum}` : undefined}
      slotProps={{ htmlInput: { min: minimum, max: maximum, step: 'any' } }} sx={{ width: 160 }}
      onChange={event => {
        const next = event.target.value
        const number = Number(next)
        const valid = next.trim() !== '' && Number.isFinite(number) && number >= minimum && number <= maximum
        setEdit({ source: valid ? number : value, draft: next })
        if (valid) onChange(number)
      }}
    />
  )
}

export default function HallControls({ halls, transforms, selected, onSelect, onChange, display, onDisplay,
  dragging, onDragging, onSave, saving, dirty, saved }: {
  halls: MapHall[]; transforms: HallTransforms; selected: number | null
  onSelect: (index: number | null) => void; onChange: (placement: HallPlacement) => void
  display: HallDisplay; onDisplay: (display: HallDisplay) => void
  dragging: boolean; onDragging: (value: boolean) => void
  onSave: () => void; saving: boolean; dirty: boolean; saved: boolean
}) {
  const placement = transforms.placements.find(p => p.hallIndex === selected)
  return (
    <Stack component="form" spacing={1} onSubmit={event => { event.preventDefault(); onSave() }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField
          select label="编辑 Hall" value={selected ?? ''} size="small" sx={{ minWidth: 150 }}
          onChange={event => onSelect(event.target.value === '' ? null : Number(event.target.value))}
        >
          <MenuItem value="">不选择</MenuItem>
          {halls.map(h => <MenuItem key={h.index} value={h.index}>{h.name ?? `Hall ${h.index + 1}`}</MenuItem>)}
        </TextField>
        <FormControlLabel label="拖动选中 Hall" control={<Checkbox
          checked={dragging} disabled={selected === null || !display.visible}
          onChange={(_, checked) => onDragging(checked)}
        />} />
        <Button type="submit" variant="contained" disabled={saving || !dirty}>
          {saving ? '保存中…' : '保存 Hall 变换'}
        </Button>
        <Typography variant="caption" role="status">{dirty ? '有未保存的变换' : saved ? '变换已保存到文件' : '已加载文件配置'}</Typography>
      </Stack>
      {placement && (
        <Stack key={placement.hallIndex} direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <NumberControl label="位移 X（米，向东）" value={placement.offset.x} minimum={-100000} maximum={100000}
            onChange={x => onChange({ ...placement, offset: { ...placement.offset, x } })} />
          <NumberControl label="位移 Y（米，向南）" value={placement.offset.y} minimum={-100000} maximum={100000}
            onChange={y => onChange({ ...placement, offset: { ...placement.offset, y } })} />
          <NumberControl label="顺时针旋转（度）" value={placement.rotation} minimum={-36000} maximum={36000}
            onChange={rotation => onChange({ ...placement, rotation })} />
          <NumberControl label="缩放（米/像素）" value={placement.scale} minimum={0.001} maximum={10}
            onChange={scale => onChange({ ...placement, scale })} />
        </Stack>
      )}
      <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap' }}>
        {([
          ['visible', 'Hall 图层'], ['boxes', 'Block 边框'], ['numbers', '摊位编号'],
          ['halfBooths', 'Half-booth a/b'], ['islands', 'Island 标记'], ['labels', '场馆标签'],
        ] as const).map(([key, label]) => <FormControlLabel key={key} label={label}
          control={<Checkbox checked={display[key]} onChange={(_, checked) => onDisplay({ ...display, [key]: checked })} />}
        />)}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        初始布局是示例随机变换，并非精确地理配准。旋转和缩放以 Hall 边界中心为基点；
        勾选拖动模式后，拖动画布只移动选中的 Hall，滚轮仍缩放地图。
      </Typography>
    </Stack>
  )
}
