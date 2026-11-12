import { useEffect, useRef } from 'react'
import { Box, Typography } from '@mui/material'
import type { OsmMapData } from './osm'
import { OsmMapRenderer } from './OsmMapRenderer'
import type { HallTransforms, MapHall } from './halls'
import { defaultHallDisplay } from './HallMapLayer'

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
        renderer ??= new OsmMapRenderer(canvas, data, () => {})
        const state = hallState.current
        renderer.setHalls(state.halls, state.transforms, defaultHallDisplay, null)
        rendererRef.current = renderer
        const bounds = canvas.getBoundingClientRect()
        renderer.resize(bounds.width, bounds.height, window.devicePixelRatio || 1)
      } catch (reason) {
        console.error('OSM rendering failed:', reason)
        onError(reason instanceof Error ? reason.message : 'OSM 地图绘制失败')
      }
    }
    function pointerDown(event: PointerEvent) {
      if (event.button !== 0 || drag || !canvas) return
      canvas.focus({ preventScroll: true })
      canvas.setPointerCapture(event.pointerId)
      drag = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
      }
      canvas.style.cursor = 'grabbing'
    }
    function pointerMove(event: PointerEvent) {
      if (!drag || drag.id !== event.pointerId) return
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y
      renderer?.pan(dx, dy)
      drag.x = event.clientX
      drag.y = event.clientY
    }
    function pointerEnd(event: PointerEvent) {
      if (!drag || drag.id !== event.pointerId || !canvas) return
      drag = null
      canvas.style.cursor = 'grab'
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
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
    observer.observe(container)
    window.addEventListener('resize', resize)
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
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
          aria-label="OSM 地图，可按住鼠标左键拖动、滚轮缩放，也可用方向键和加减键操作"
          tabIndex={0}
          style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }}
        />
        <Box sx={{ position: 'absolute', right: 6, bottom: 4, bgcolor: 'rgba(255,255,255,0.9)', px: 0.5 }}>
          <Typography variant="caption">
            © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
          </Typography>
        </Box>
      </Box>
  )
}
