import { useEffect, useRef, useState } from 'react'
import {
  Accordion, AccordionDetails, AccordionSummary, Box, Checkbox, FormControlLabel,
  FormGroup, Paper, Slider, Typography,
} from '@mui/material'
import type { OsmMapData } from './osm'
import { OsmMapRenderer } from './OsmMapRenderer'
import type { HallTransforms, MapHall } from './halls'
import { defaultHallDisplay } from './HallMapLayer'
import { dragRotation } from './viewport'

interface OsmCanvasProps {
  data: OsmMapData
  halls: MapHall[]
  transforms: HallTransforms
  onError: (message: string) => void
}

export default function OsmCanvas({ data, halls, transforms, onError }: OsmCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<OsmMapRenderer | null>(null)
  const hallState = useRef({ halls, transforms })
  const [rotation, setRotation] = useState(0)
  const [levels, setLevels] = useState<number[]>([1, 2])
  const [hoverLabel, setHoverLabel] = useState('')
  const viewState = useRef({ rotation, levels })

  useEffect(() => {
    viewState.current = { rotation, levels }
    rendererRef.current?.setRotation(rotation)
    rendererRef.current?.setLevels(levels)
  }, [rotation, levels])

  useEffect(() => {
    hallState.current = { halls, transforms }
    rendererRef.current?.setHalls(halls, transforms, defaultHallDisplay, null)
  }, [halls, transforms])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    let renderer: OsmMapRenderer | null = null
    let drag: {
      id: number; x: number; y: number
    } | null = null
    const observer = new ResizeObserver(resize)
    function resize() {
      if (!canvas || !container) return
      try {
        renderer ??= new OsmMapRenderer(canvas, data, () => {}, setRotation, setHoverLabel)
        const state = hallState.current
        renderer.setHalls(state.halls, state.transforms, defaultHallDisplay, null)
        rendererRef.current = renderer
        const bounds = canvas.getBoundingClientRect()
        renderer.resize(bounds.width, bounds.height, window.devicePixelRatio || 1)
        renderer.setRotation(viewState.current.rotation)
        renderer.setLevels(viewState.current.levels)
      } catch (reason) {
        console.error('OSM rendering failed:', reason)
        onError(reason instanceof Error ? reason.message : 'OSM 地图绘制失败')
      }
    }
    function pointerDown(event: PointerEvent) {
      if (event.button !== 0 || drag || !canvas) return
      event.preventDefault()
      canvas.focus({ preventScroll: true })
      canvas.setPointerCapture(event.pointerId)
      drag = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
      }
      canvas.style.cursor = event.altKey ? 'crosshair' : 'grabbing'
    }
    function pointerMove(event: PointerEvent) {
      if (canvas) {
        const bounds = canvas.getBoundingClientRect()
        renderer?.setPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
      }
      if (!drag || drag.id !== event.pointerId) return
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y
      if (event.altKey && canvas) {
        const bounds = canvas.getBoundingClientRect()
        renderer?.rotate(dragRotation(
          { x: drag.x, y: drag.y }, { x: event.clientX, y: event.clientY },
          { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 },
        ))
      } else {
        renderer?.pan(dx, dy)
      }
      if (canvas) canvas.style.cursor = event.altKey ? 'crosshair' : 'grabbing'
      drag.x = event.clientX
      drag.y = event.clientY
    }
    function pointerEnd(event: PointerEvent) {
      if (!drag || drag.id !== event.pointerId || !canvas) return
      drag = null
      canvas.style.cursor = 'grab'
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    function pointerLeave() {
      renderer?.setPointer(null)
    }
    function wheel(event: WheelEvent) {
      event.preventDefault()
      if (!canvas) return
      const bounds = canvas.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1
      const delta = Math.max(-1000, Math.min(1000, event.deltaY * unit))
      renderer?.zoom(Math.exp(-delta * 0.0015), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    }
    function keyDown(event: KeyboardEvent) {
      if (event.key === '+' || event.key === '=') renderer?.zoom(1.4)
      else if (event.key === '-') renderer?.zoom(1 / 1.4)
      else if (event.key === 'Home') renderer?.fit()
      else if (event.key === 'ArrowLeft') renderer?.pan(60, 0)
      else if (event.key === 'ArrowRight') renderer?.pan(-60, 0)
      else if (event.key === 'ArrowUp') renderer?.pan(0, 60)
      else if (event.key === 'ArrowDown') renderer?.pan(0, -60)
      else return
      event.preventDefault()
    }
    resize()
    observer.observe(container)
    window.addEventListener('resize', resize)
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerleave', pointerLeave)
    canvas.addEventListener('pointerup', pointerEnd)
    canvas.addEventListener('pointercancel', pointerEnd)
    canvas.addEventListener('lostpointercapture', pointerEnd)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('keydown', keyDown)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerleave', pointerLeave)
      canvas.removeEventListener('pointerup', pointerEnd)
      canvas.removeEventListener('pointercancel', pointerEnd)
      canvas.removeEventListener('lostpointercapture', pointerEnd)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('keydown', keyDown)
      if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id)
      canvas.style.cursor = 'grab'
      renderer?.dispose()
      rendererRef.current = null
    }
  }, [data, onError])

  return (
      <Box
        ref={containerRef}
        sx={{
          position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          aria-label="OSM 地图，可拖动、滚轮缩放、Alt 拖动旋转，也可用方向键和加减键操作"
          tabIndex={0}
          style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }}
        />
        <Paper elevation={4} sx={{
          position: 'absolute', right: 16, top: 72, width: 180, p: 2,
          maxHeight: 'calc(100% - 120px)', overflow: 'auto',
        }}>
          <Typography id="map-rotation-label" variant="body2">rotation</Typography>
          <Slider aria-labelledby="map-rotation-label" value={rotation} min={-180} max={180}
            step={1} valueLabelDisplay="auto" valueLabelFormat={value => `${Math.round(value)}°`}
            onChange={(_, value) => {
              if (typeof value === 'number') setRotation(value)
            }} />
          <Accordion disableGutters elevation={0} defaultExpanded>
            <AccordionSummary aria-controls="map-level-options" id="map-level-label"
              expandIcon={<Box sx={{ width: 7, height: 7, borderRight: '1px solid', borderBottom: '1px solid',
                transform: 'rotate(45deg)' }} />}>
              <Typography variant="body2">level</Typography>
            </AccordionSummary>
            <AccordionDetails id="map-level-options" sx={{ p: 0 }}>
              <FormGroup aria-labelledby="map-level-label">
                {[1, 2, 3, 4].map(level => (
                  <FormControlLabel key={level} label={String(level)}
                    control={<Checkbox checked={levels.includes(level)} onChange={(_, checked) => {
                      setLevels(previous => checked ? [...previous, level] : previous.filter(value => value !== level))
                    }} />} />
                ))}
              </FormGroup>
            </AccordionDetails>
          </Accordion>
          <Typography variant="caption" component="div" sx={{
            mt: 1, color: 'text.secondary', overflowWrap: 'anywhere', minHeight: '1.5em',
          }}>
            {hoverLabel || '—'}
          </Typography>
        </Paper>
        <Box sx={{ position: 'absolute', right: 6, bottom: 4, bgcolor: 'rgba(255,255,255,0.9)', px: 0.5 }}>
          <Typography variant="caption">
            © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
          </Typography>
        </Box>
      </Box>
  )
}
