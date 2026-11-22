import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, MenuItem, Popover, Stack, TextField, Typography } from '@mui/material'
import type { BoothListItem } from './api'
import { saveBoothFavorite } from './api'
import { BoothLinks } from './BoothMedia'
import type { BoothLinkField } from './BoothMedia'

type Patch = Partial<Pick<BoothListItem, 'colour' | 'memo' | BoothLinkField>>
type Edit = { kind: 'favorite'; patch: { colour?: string | null; memo?: string } }
  | { kind: 'link'; field: BoothLinkField; value: string | null }

export default function BoothEditor({ booth, anchor, isAdmin, onChange, onClose }: {
  booth: BoothListItem
  anchor: HTMLElement
  isAdmin: boolean
  onChange: (patch: Patch, colours: string[]) => void
  onClose: () => void
}) {
  const [colours, setColours] = useState<string[]>([])
  const [paletteLoading, setPaletteLoading] = useState(true)
  const [paletteAttempt, setPaletteAttempt] = useState(0)
  const [paletteError, setPaletteError] = useState<string | null>(null)
  const [colour, setColour] = useState(booth.colour)
  const [memo, setMemo] = useState(booth.memo ?? '')
  const [links, setLinks] = useState(booth)
  const [field, setField] = useState<BoothLinkField | null>(null)
  const [linkValue, setLinkValue] = useState('')
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const applied = useRef<Patch>({ colour: booth.colour, memo: booth.memo ?? '',
    circle_id: booth.circle_id, pixiv_id: booth.pixiv_id, twitter_id: booth.twitter_id })
  const queue = useRef<Promise<boolean>>(Promise.resolve(true))
  const failures = useRef(new Map<string, { edit: Edit; message: string }>())

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/colours', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) })
      .then(async response => {
        const body: { colours: { colour: string }[]; message?: string } = await response.json()
        if (!response.ok) throw new Error(body.message ?? '颜色加载失败')
        setColours(body.colours.map(entry => entry.colour))
        setPaletteError(null)
      }).catch((reason: unknown) => {
        if (controller.signal.aborted) return
        console.error('Editor colours failed:', reason)
        setPaletteError(reason instanceof Error ? reason.message : '颜色加载失败')
      }).finally(() => { if (!controller.signal.aborted) setPaletteLoading(false) })
    return () => controller.abort()
  }, [paletteAttempt])

  function save(edit: Edit, retry = false): Promise<boolean> {
    const key = edit.kind === 'link' ? edit.field : edit.patch.memo !== undefined ? 'memo' : 'colour'
    const value = edit.kind === 'link' ? edit.value : edit.patch.memo !== undefined ? edit.patch.memo : edit.patch.colour
    if (!retry && applied.current[key] === value) return queue.current
    const patch: Patch = edit.kind === 'link' ? { [edit.field]: edit.value } : edit.patch
    applied.current = { ...applied.current, ...patch }
    if (edit.kind === 'favorite' && edit.patch.colour !== undefined) setColour(edit.patch.colour)
    if (edit.kind === 'link') setLinks(previous => ({ ...previous, ...patch }))
    onChange(patch, colours)
    setPending(count => count + 1)
    setSaved(false)
    const operation = async () => {
      try {
        if (edit.kind === 'favorite') await saveBoothFavorite(booth.id, edit.patch)
        else {
          const response = await fetch(`/api/booths/${booth.id}/link`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ field: edit.field, value: edit.value }),
            signal: AbortSignal.timeout(20_000),
          })
          const result: { message?: string } = await response.json()
          if (!response.ok) throw new Error(result.message ?? `保存失败（HTTP ${response.status}）`)
        }
        failures.current.delete(key)
        setError([...failures.current.values()].map(failure => failure.message).join('；') || null)
        setSaved(failures.current.size === 0)
        return true
      } catch (reason) {
        console.error('Booth edit failed:', reason)
        failures.current.set(key, { edit, message: reason instanceof Error ? reason.message : '保存失败' })
        setError([...failures.current.values()].map(failure => failure.message).join('；'))
        return false
      } finally { setPending(count => count - 1) }
    }
    const next = queue.current.then(operation)
    queue.current = next
    return next
  }

  function saveMemo() {
    return save({ kind: 'favorite', patch: { memo } })
  }

  async function close() {
    if (await saveMemo() && !failures.current.size) onClose()
  }

  return <Popover open anchorEl={anchor} onClose={() => { void close() }}
    anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
    <Stack role="dialog" aria-label={`${booth.circle_name} 操作面板`} spacing={1.5} sx={{ p: 2, width: 420, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box' }}>
      <Typography variant="subtitle2">{booth.circle_name}</Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <TextField select label="收藏颜色" size="small" value={colour ?? ''} fullWidth disabled={paletteLoading || !!paletteError || pending > 0}
          helperText={!paletteLoading && !paletteError && !colours.length ? '暂无已有颜色，请先导入收藏' : undefined}
          onChange={event => { void save({ kind: 'favorite', patch: { colour: event.target.value } }) }}>
          <MenuItem value="" disabled>未收藏</MenuItem>
          {[...new Set([...(colour ? [colour] : []), ...colours])].map(value =>
            <MenuItem key={value} value={value}><Chip size="small" label={value} sx={theme => ({ bgcolor: value, color: theme.palette.getContrastText(value) })} /></MenuItem>)}
        </TextField>
        <Button size="small" disabled={!colour || pending > 0} sx={{ flexShrink: 0 }} onClick={() => { void save({ kind: 'favorite', patch: { colour: null } }) }}>取消收藏</Button>
      </Stack>
      {paletteError && <Alert severity="error" action={<Button onClick={() => { setPaletteLoading(true); setPaletteAttempt(value => value + 1) }}>重试</Button>}>{paletteError}</Alert>}
      <TextField label="Memo" multiline minRows={4} maxRows={12} value={memo}
        onChange={event => { setMemo(event.target.value); setSaved(false) }} onBlur={() => { void saveMemo() }} />
      {isAdmin && <>
        <BoothLinks booth={links} onEdit={next => { setField(next); setLinkValue(links[next] ?? '') }} />
        {field && <Box component="form" onSubmit={event => {
          event.preventDefault()
          void save({ kind: 'link', field, value: linkValue.trim() || null })
        }} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TextField key={field} autoFocus fullWidth size="small" label={`${field === 'circle_id' ? 'Circle.ms' : field === 'pixiv_id' ? 'Pixiv' : 'Twitter / X'} ID`}
            value={linkValue} onChange={event => setLinkValue(event.target.value)} />
          <Button type="submit" disabled={pending > 0}>保存</Button>
        </Box>}
      </>}
      {error && <Alert severity="error" action={<Button disabled={pending > 0} onClick={() => {
        for (const failure of [...failures.current.values()]) void save(failure.edit, true)
      }}>重试</Button>}>{error}</Alert>}
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }}>
        {pending > 0 ? <CircularProgress size={18} aria-label="正在保存" /> : <Typography variant="caption" color="text.secondary">{saved ? '已保存' : '颜色即时保存，Memo 失焦保存'}</Typography>}
        <Button size="small" disabled={pending > 0} onMouseDown={event => event.preventDefault()} onClick={() => { void close() }}>完成</Button>
      </Stack>
    </Stack>
  </Popover>
}
