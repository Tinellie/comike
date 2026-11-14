import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'
import { Box, LinearProgress, Paper, Popper, Typography } from '@mui/material'
import type { Instance } from '@popperjs/core'
import { BoothImages } from '../booths/BoothMedia'
import { locationLabel } from '../booths/api'
import type { MapBoothLocation } from '../booths/api'
import type { MapBoothHit } from './OsmMapRenderer'

export interface BoothHoverHandle {
  move: (x: number, y: number) => void
}

interface Props {
  hit: MapBoothHit | null
  load: (hit: MapBoothHit) => Promise<MapBoothLocation>
  ref: Ref<BoothHoverHandle>
}

export default function BoothHoverPreview({ hit, load, ref }: Props) {
  const pointer = useRef({ x: 0, y: 0 })
  const popper = useRef<Instance | null>(null)
  const anchor = useMemo(() => ({
    getBoundingClientRect: () => new DOMRect(pointer.current.x, pointer.current.y, 0, 0),
  }), [])
  const [result, setResult] = useState<{
    hit: MapBoothHit; load: Props['load']; data?: MapBoothLocation; error?: string
  } | null>(null)
  const current = result?.hit === hit && result?.load === load ? result : null
  useImperativeHandle(ref, () => ({
    move(x, y) { pointer.current = { x, y }; void popper.current?.update() },
  }), [])

  useEffect(() => {
    if (!hit) return
    let active = true
    const timer = window.setTimeout(() => {
      void load(hit).then(data => {
        if (active) setResult({ hit, load, data })
      }).catch((reason: unknown) => {
        if (!active) return
        console.error('Map hover preview failed:', reason)
        setResult({ hit, load, error: reason instanceof Error ? reason.message : '社团预览加载失败' })
      })
    }, 100)
    return () => { active = false; window.clearTimeout(timer) }
  }, [hit, load])

  useEffect(() => { void popper.current?.update() }, [current])

  return <Popper open={hit !== null} anchorEl={anchor} placement="top" popperRef={popper} aria-label="社团预览"
    modifiers={[
      { name: 'offset', options: { offset: [0, 18] } },
      { name: 'flip', enabled: false },
      { name: 'preventOverflow', options: { padding: 8, altAxis: true } },
    ]} sx={{ zIndex: theme => theme.zIndex.tooltip, pointerEvents: 'none' }}>
    <Paper elevation={6} sx={{
      position: 'relative', width: 168, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box',
      p: 0.5, borderRadius: 2, textAlign: 'center',
      '&::after': {
        content: '""', position: 'absolute', bottom: -7, left: '50%', ml: '-7px',
        width: 14, height: 14, bgcolor: 'background.paper', transform: 'rotate(45deg)',
      },
    }}>
      {!current && <>
        <Typography variant="body2">{hit && `${hit.hallGroup}${hit.island}${hit.number}${hit.suffix}`}</Typography>
        <LinearProgress aria-label="加载社团预览" sx={{ mt: 1 }} />
      </>}
      {current?.error && <>
        <Typography variant="body2" color="error">{current.error}</Typography>
        <Typography variant="caption" color="text.secondary">移开鼠标后重新悬浮可重试</Typography>
      </>}
      {current?.data && <Box sx={{ maxHeight: 'min(320px, 45vh)', overflow: 'hidden', borderRadius: 'inherit' }}>
        {current.data.circles.length ? current.data.circles.map(circle => <Box key={circle.id} sx={{ '& + &': { mt: 1 } }}>
          <Typography variant="caption" color="text.secondary">{locationLabel(circle)}</Typography>
          <Typography variant="body2" sx={{ fontWeight: 700, overflowWrap: 'anywhere', mb: 0.5 }}>{circle.circle_name}</Typography>
          <Box sx={{ '& > div': { minHeight: 0 } }}>
            <BoothImages booth={circle} />
          </Box>
        </Box>) : <Typography variant="body2">此位置暂无社团记录</Typography>}
      </Box>}
    </Paper>
  </Popper>
}
