import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Popover, Stack, Typography } from '@mui/material'

interface ColourPriority {
  colour: string
  priority: number
}

async function requestColours(signal: AbortSignal, colours?: string[]): Promise<ColourPriority[]> {
  const response = await fetch('/api/colours', {
    method: colours ? 'PUT' : 'GET',
    headers: colours ? { 'Content-Type': 'application/json' } : undefined,
    body: colours ? JSON.stringify({ colours }) : undefined,
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  })
  const body: { colours: ColourPriority[]; message?: string } = await response.json()
  if (!response.ok) throw new Error(body.message ?? `颜色配置请求失败（HTTP ${response.status}）`)
  return body.colours
}

export default function ColourPreferences({ onSaved }: { onSaved?: (colours: string[]) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [colours, setColours] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  async function load() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setColours([]); setLoading(true); setError(null); setUnsaved(false)
    try {
      const entries = await requestColours(controller.signal)
      if (!controller.signal.aborted) setColours(entries.map(entry => entry.colour))
    } catch (reason) {
      if (!controller.signal.aborted) {
        console.error('Colour preferences loading failed:', reason)
        setError(reason instanceof Error ? reason.message : '颜色配置加载失败')
      }
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }

  async function save(next: string[]) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setColours(next); setSaving(true); setUnsaved(true); setError(null)
    try {
      const entries = await requestColours(controller.signal, next)
      if (!controller.signal.aborted) {
        const ordered = entries.map(entry => entry.colour)
        setColours(ordered); setUnsaved(false)
        onSaved?.(ordered)
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        console.error('Colour preference saving failed:', reason)
        setError(reason instanceof Error ? reason.message : '颜色配置保存失败')
      }
    } finally { if (!controller.signal.aborted) setSaving(false) }
  }

  function move(from: number, to: number) {
    if (saving || unsaved || from < 0 || to < 0 || to >= colours.length || from === to) return
    const next = [...colours]
    const [colour] = next.splice(from, 1)
    next.splice(to, 0, colour!)
    void save(next)
  }

  return <>
    <Button size="small" variant="outlined" disabled={saving} aria-haspopup="dialog" aria-expanded={!!anchor}
      onClick={event => { setAnchor(event.currentTarget); void load() }}>颜色</Button>
    <Popover open={!!anchor} anchorEl={anchor} onClose={() => { if (!saving) setAnchor(null) }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }} slotProps={{ paper: { role: 'dialog', 'aria-label': '颜色优先级' } }}>
      <Stack spacing={1.5} sx={{ p: 2, width: 320, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', maxHeight: '75vh', overflowY: 'auto' }}>
        <Typography variant="subtitle1">颜色优先级</Typography>
        <Typography variant="body2" color="text.secondary">拖动调整顺序，松开自动保存。也可使用方向键或上下按钮。所有活动共用此顺序。</Typography>
        {loading && <CircularProgress size={24} aria-label="加载颜色优先级" />}
        {error && <Alert severity="error">{error}</Alert>}
        {!loading && !error && !colours.length && <Typography variant="body2">暂无颜色，请先导入收藏。</Typography>}
        {!loading && <Box component="ol" aria-label="颜色顺序" sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {colours.map((colour, index) => <Box component="li" key={colour} tabIndex={0}
            aria-label={`颜色 ${colour}，优先级 ${index + 1}`} draggable={!saving && !unsaved}
            onDragStart={event => { event.dataTransfer.setData('text/plain', colour); event.dataTransfer.effectAllowed = 'move'; setDragging(colour) }}
            onDragEnd={() => setDragging(null)}
            onDragOver={event => { if (dragging && !saving && !unsaved) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
            onDrop={event => { event.preventDefault(); move(colours.indexOf(event.dataTransfer.getData('text/plain')), index); setDragging(null) }}
            onKeyDown={event => {
              if (event.target !== event.currentTarget || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
              event.preventDefault()
              move(index, index + (event.key === 'ArrowUp' ? -1 : 1))
            }}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 0.75, mb: 0.5, border: 1, borderColor: 'divider', borderRadius: 1,
              cursor: saving || unsaved ? 'default' : 'grab', opacity: dragging === colour ? 0.5 : 1 }}>
            <Typography aria-hidden="true" color="text.secondary">⋮⋮</Typography>
            <Typography variant="caption" sx={{ minWidth: 18 }}>{index + 1}</Typography>
            <Chip size="small" label={colour} sx={theme => ({ bgcolor: colour, color: theme.palette.getContrastText(colour) })} />
            <Box sx={{ flex: 1 }} />
            <IconButton size="small" aria-label={`上移 ${colour}`} disabled={saving || unsaved || index === 0} onClick={() => move(index, index - 1)}>↑</IconButton>
            <IconButton size="small" aria-label={`下移 ${colour}`} disabled={saving || unsaved || index === colours.length - 1} onClick={() => move(index, index + 1)}>↓</IconButton>
          </Box>)}
        </Box>}
        <Typography role="status" variant="caption" color="text.secondary">
          {saving ? '正在保存…' : unsaved ? '更改尚未保存' : !loading && !error ? '顺序已保存' : ''}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          {error && <Button size="small" disabled={loading || saving} onClick={() => { void load() }}>重新加载</Button>}
          {unsaved && <Button size="small" disabled={saving} onClick={() => { void save(colours) }}>重试保存</Button>}
          <Button size="small" disabled={saving} onClick={() => setAnchor(null)}>完成</Button>
        </Stack>
      </Stack>
    </Popover>
  </>
}
