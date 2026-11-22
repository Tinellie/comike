import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { Alert, Box, LinearProgress, Paper, Typography } from '@mui/material'
import { locationLabel } from '../booths/api'
import type { BoothDetail, MapBoothLocation } from '../booths/api'
import type { MapBoothHit, RouteListStop } from './OsmMapRenderer'

interface Props {
  stops: RouteListStop[]
  load: (hit: MapBoothHit) => Promise<MapBoothLocation>
  onInspect: (stop: RouteListStop | null) => void
  onContextMenu: (event: MouseEvent, stop: RouteListStop) => void
  onReorder: (from: number, to: number) => void
  error: string | null
  hoveredStopId?: string
}

function StopDetails({ stop, load }: Pick<Props, 'load'> & { stop: RouteListStop }) {
  const [detail, setDetail] = useState<{ circle?: BoothDetail; failed?: boolean } | null>(null)
  useEffect(() => {
    let active = true
    void load(stop.hit).then(({ circles }) => {
      if (active) setDetail({ circle: circles.find(circle => circle.booth_suffix === stop.suffix) ?? circles[0] })
    }).catch((reason: unknown) => {
      if (!active) return
      console.error('Map route stop loading failed:', reason)
      setDetail({ failed: true })
    })
    return () => { active = false }
  }, [stop, load])
  const circle = detail?.circle
  const { hallGroup, island, number } = stop.hit
  const label = circle ? locationLabel(circle) : `${hallGroup} ${island}${number}${stop.suffix}`
  return <>
    <Box sx={{ width: 52, height: 54, flexShrink: 0, borderRadius: 0.5, bgcolor: 'action.hover' }}>
      {circle?.imageUrls[0] && <Box component="img" src={circle.imageUrls[0]} alt="" loading="lazy"
        decoding="async" draggable={false} onError={event => { event.currentTarget.hidden = true }}
        sx={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
    </Box>
    <Box sx={{ minWidth: 0, flex: 1 }}>
      <Typography component="div" noWrap variant="body2" title={circle?.circle_name} sx={{ fontWeight: 700 }}>
        {circle?.circle_name ?? (detail?.failed ? '加载失败' : detail ? '无社团记录' : <LinearProgress aria-label="加载社团" />)}
      </Typography>
      <Typography noWrap variant="body2" color="text.secondary" title={circle?.author_name ?? undefined}>
        {circle?.author_name || '—'}
      </Typography>
      <Typography noWrap variant="caption" component="div" color="text.secondary" title={label}>{label}</Typography>
    </Box>
  </>
}

export default function RouteList({ stops, load, onInspect, onContextMenu, onReorder, error, hoveredStopId }: Props) {
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const panel = useRef<HTMLElement>(null)
  const inspectTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(inspectTimer.current), [stops])

  useEffect(() => {
    const container = panel.current
    const row = container?.querySelector('[data-map-hovered]')
    if (!container || !row || !hoveredStopId || dragging !== null) return
    const bounds = container.getBoundingClientRect()
    const item = row.getBoundingClientRect()
    const top = bounds.top + container.clientTop
    const bottom = top + container.clientHeight
    if (item.top < top) container.scrollTop += item.top - top
    else if (item.bottom > bottom) container.scrollTop += item.bottom - bottom
  }, [hoveredStopId, dragging, stops])

  function cancelInspect() {
    window.clearTimeout(inspectTimer.current)
    onInspect(null)
  }

  function endDrag() {
    setDragging(null)
    setOver(null)
  }
  return <Paper component="section" ref={panel} aria-label="路径列表" elevation={4} sx={{
    position: 'absolute', top: 58, right: 236, maxHeight: 'calc(100% - 94px)',
    width: 'min(240px, calc(100% - 244px))', overflow: 'auto',
    '@media (max-width: 430px)': { right: 16, top: 'auto', bottom: 36, width: 'calc(100% - 32px)', maxHeight: '30%' },
  }}>
    {error && <Alert severity="warning" sx={{ py: 0 }}>{error}</Alert>}
    <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0.5 }}>
      {stops.map((stop, index) => <Box component="li" key={stop.id} draggable tabIndex={0}
        data-map-hovered={hoveredStopId === stop.id ? '' : undefined}
        onMouseEnter={() => {
          window.clearTimeout(inspectTimer.current)
          if (dragging === null) inspectTimer.current = window.setTimeout(() => onInspect(stop), 350)
        }}
        onMouseLeave={cancelInspect}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) onInspect(stop) }}
        onBlur={cancelInspect}
        onContextMenu={event => {
          cancelInspect()
          onContextMenu(event, stop)
        }}
        onDragStart={event => {
          event.dataTransfer.setData('text/plain', stop.id)
          event.dataTransfer.effectAllowed = 'move'
          cancelInspect()
          setDragging(index)
        }}
        onDragEnd={endDrag}
        onDragOver={event => {
          if (dragging === null) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setOver(index)
        }}
        onDrop={event => {
          if (dragging === null) return
          event.preventDefault()
          if (dragging !== index) onReorder(dragging, index)
          endDrag()
        }}
        onKeyDown={event => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
          const to = index + (event.key === 'ArrowUp' ? -1 : 1)
          event.preventDefault()
          if (to >= 0 && to < stops.length) onReorder(index, to)
        }}
        sx={{
          position: 'relative', display: 'flex', alignItems: 'center', gap: 0.75, cursor: 'grab',
          pl: 0.75, pr: 0.5, py: 0.5, borderLeft: '4px solid', borderLeftColor: stop.colour, borderRadius: 0.5,
          opacity: dragging === index ? 0.45 : 1, '&:hover, &:focus-visible': { bgcolor: 'action.hover' },
          ...(hoveredStopId === stop.id && { bgcolor: 'action.selected' }),
          ...(over === index && dragging !== null && dragging !== index && {
            '&::after': { content: '""', position: 'absolute', insetInline: 0, height: 2, bgcolor: 'primary.main',
              ...(dragging < index ? { bottom: 0 } : { top: 0 }) },
          }),
        }}>
        <StopDetails stop={stop} load={load} />
      </Box>)}
    </Box>
  </Paper>
}
