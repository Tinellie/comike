import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox, FormControlLabel,
  Chip, FormGroup, LinearProgress, MenuItem, Paper, Popover, Slider, Switch, TextField, Typography,
} from '@mui/material'
import type { OsmMapData } from './osm'
import { OsmMapRenderer } from './OsmMapRenderer'
import type { MapBoothHit } from './OsmMapRenderer'
import type { HallTransforms, MapHall } from './halls'
import { defaultHallDisplay, hallRouteColor } from './HallMapLayer'
import { dragRotation } from './viewport'
import type { MapBoothData, MapBoothLocation } from '../booths/api'
import BoothHoverPreview from './BoothHoverPreview'
import type { BoothHoverHandle } from './BoothHoverPreview'
import { mapBoothKey } from './boothLookup'
import type { FavoriteHighlights } from './favoriteHighlights'

interface OsmCanvasProps {
  data: OsmMapData
  halls: MapHall[]
  transforms: HallTransforms
  routesVisible: boolean
  onError: (message: string) => void
  onBoothClick: (hit: MapBoothHit) => void
  days: { weekday: string; label: string }[]
  weekday: string
  onDayChange: (weekday: string) => void
  boothData: MapBoothData | null
  favoriteHighlights: FavoriteHighlights
  loadBooth: (hit: MapBoothHit) => Promise<MapBoothLocation>
}

export default function OsmCanvas({ data, halls, transforms, routesVisible, onError, onBoothClick, days, weekday, onDayChange, boothData, favoriteHighlights, loadBooth }: OsmCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<OsmMapRenderer | null>(null)
  const hallState = useRef({ halls, transforms })
  const [rotation, setRotation] = useState(0)
  const [levels, setLevels] = useState<number[]>([1, 2])
  const [hoverLabel, setHoverLabel] = useState('')
  const [hoverHit, setHoverHit] = useState<MapBoothHit | null>(null)
  const [genreEnabled, setGenreEnabled] = useState(false)
  const [selectedGenres, setSelectedGenres] = useState<string[] | null>(null)
  const [genreAnchor, setGenreAnchor] = useState<HTMLElement | null>(null)
  const genreState = useRef({ enabled: genreEnabled, selected: selectedGenres })
  const tooltipRef = useRef<BoothHoverHandle | null>(null)
  const [pdfVisible, setPdfVisible] = useState(false)
  const routesState = useRef(routesVisible)
  const [selectedRoutes, setSelectedRoutes] = useState<ReadonlySet<string>>(() => new Set())
  const selectedRoutesState = useRef(selectedRoutes)
  const [pdfImages, setPdfImages] = useState<ReadonlyMap<MapHall, HTMLImageElement>>(new Map())
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [pdfAttempt, setPdfAttempt] = useState(0)
  const pdfCache = useRef(new WeakMap<MapHall, HTMLImageElement>())
  const pdfState = useRef<ReadonlyMap<MapHall, HTMLImageElement>>(new Map())
  const viewState = useRef({ rotation, levels })
  const clickHandler = useRef(onBoothClick)
  const boothState = useRef(boothData)
  const favoriteState = useRef(favoriteHighlights)
  useEffect(() => { clickHandler.current = onBoothClick }, [onBoothClick])

  useEffect(() => {
    routesState.current = routesVisible
    rendererRef.current?.setRoutesVisible(routesVisible)
  }, [routesVisible])

  useEffect(() => {
    selectedRoutesState.current = selectedRoutes
    rendererRef.current?.setSelectedRoutes(selectedRoutes)
  }, [selectedRoutes])

  useEffect(() => {
    genreState.current = { enabled: genreEnabled, selected: selectedGenres }
    rendererRef.current?.setGenreDisplay(genreEnabled, selectedGenres)
  }, [genreEnabled, selectedGenres])

  useEffect(() => {
    pdfState.current = pdfVisible ? pdfImages : new Map()
    rendererRef.current?.setPdfImages(pdfState.current)
  }, [pdfVisible, pdfImages])

  useEffect(() => {
    if (!pdfVisible) return
    const controller = new AbortController()
    const urls: string[] = []
    async function load() {
      try {
        const entries = await Promise.all(halls.map(async hall => {
          const cached = pdfCache.current.get(hall)
          if (cached) return [hall, cached] as const
          const pdf = hall.page.pdfPreview
          if (!pdf) throw new Error(`${hall.name ?? 'Hall'} 缺少 PDF 原图信息，请重新导出地图数据`)
          const response = await fetch(`/api/preview/${pdf.image}`, { signal: controller.signal, cache: 'no-store' })
          if (!response.ok) throw new Error(`PDF 原图加载失败（HTTP ${response.status}）`)
          const blob = await response.blob()
          if (controller.signal.aborted) throw controller.signal.reason
          const url = URL.createObjectURL(blob)
          urls.push(url)
          const image = new Image()
          image.src = url
          await image.decode()
          if (image.naturalWidth !== pdf.width || image.naturalHeight !== pdf.height) {
            throw new Error('PDF 原图尺寸与识别坐标不一致，请重新生成识别输出')
          }
          if (!controller.signal.aborted) pdfCache.current.set(hall, image)
          return [hall, image] as const
        }))
        if (controller.signal.aborted) return
        setPdfImages(new Map(entries))
        setPdfError(null)
      } catch (reason) {
        if (controller.signal.aborted) return
        controller.abort()
        console.error('Map PDF image loading failed:', reason)
        setPdfError(reason instanceof Error ? reason.message : 'PDF 原图加载失败')
      } finally {
        for (const url of urls) URL.revokeObjectURL(url)
      }
    }
    void load()
    return () => {
      controller.abort()
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [halls, pdfVisible, pdfAttempt])

  useEffect(() => {
    boothState.current = boothData
    rendererRef.current?.setBoothData(boothData)
  }, [boothData])

  useEffect(() => {
    favoriteState.current = favoriteHighlights
    rendererRef.current?.setFavoriteHighlights(favoriteHighlights)
  }, [favoriteHighlights])

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
      id: number; x: number; y: number; startX: number; startY: number; moved: boolean
    } | null = null
    let clickable = false
    function updateCursor() {
      if (canvas && !drag) canvas.style.cursor = clickable ? 'pointer' : 'grab'
    }
    const observer = new ResizeObserver(resize)
    function resize() {
      if (!canvas || !container) return
      try {
        renderer ??= new OsmMapRenderer(canvas, data, () => {}, setRotation, (label, canClick, hit) => {
          setHoverLabel(label)
          clickable = canClick
          updateCursor()
          setHoverHit(previous => {
            const next = drag ? null : hit
            return previous && next && mapBoothKey(previous) === mapBoothKey(next) ? previous : next
          })
        })
        const state = hallState.current
        renderer.setHalls(state.halls, state.transforms, defaultHallDisplay, null)
        rendererRef.current = renderer
        const bounds = canvas.getBoundingClientRect()
        renderer.resize(bounds.width, bounds.height, window.devicePixelRatio || 1)
        renderer.setRotation(viewState.current.rotation)
        renderer.setLevels(viewState.current.levels)
        renderer.setBoothData(boothState.current)
        renderer.setFavoriteHighlights(favoriteState.current)
        renderer.setGenreDisplay(genreState.current.enabled, genreState.current.selected)
        renderer.setPdfImages(pdfState.current)
        renderer.setRoutesVisible(routesState.current)
        renderer.setSelectedRoutes(selectedRoutesState.current)
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
        startX: event.clientX, startY: event.clientY, moved: event.altKey,
      }
      canvas.style.cursor = event.altKey ? 'crosshair' : 'grabbing'
      setHoverHit(null)
    }
    function pointerMove(event: PointerEvent) {
      tooltipRef.current?.move(event.clientX, event.clientY)
      if (canvas) {
        const bounds = canvas.getBoundingClientRect()
        renderer?.setPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
      }
      if (!drag || drag.id !== event.pointerId) return
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true
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
      const clicked = event.type === 'pointerup' && !drag.moved
      drag = null
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (clicked) {
        const bounds = canvas.getBoundingClientRect()
        const hit = renderer?.pickBooth({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        if (hit) clickHandler.current(hit)
      }
      updateCursor()
    }
    function pointerLeave() {
      setHoverHit(null)
      clickable = false
      updateCursor()
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
    function navigationKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || drag
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || (event.target instanceof HTMLElement
          && (event.target.isContentEditable || event.target.closest('input, textarea, select, button, a, [role="combobox"]')))) return
      if (event.code === 'Space') {
        if (!renderer?.selectNavigationPoint()) return
      } else if (event.key.toLowerCase() === 'x' && renderer?.hasNavigationSelection()) {
        renderer.clearNavigation()
      } else return
      event.preventDefault()
    }
    resize()
    observer.observe(container)
    window.addEventListener('resize', resize)
    window.addEventListener('keydown', navigationKeyDown)
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
      window.removeEventListener('keydown', navigationKeyDown)
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
        <BoothHoverPreview ref={tooltipRef} hit={boothData ? hoverHit : null} load={loadBooth} />
        <canvas
          ref={canvasRef}
          aria-label="OSM 地图，可拖动、滚轮缩放、Alt 拖动旋转，也可用方向键和加减键操作"
          tabIndex={0}
          style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }}
        />
        <Paper elevation={4} sx={{
          position: 'absolute', right: 16, top: 58, width: 180, pt: 2.5, px: 2, pb: 2,
          maxHeight: 'calc(100% - 94px)', overflow: 'auto',
          display: 'flex', flexDirection: 'column', gap: 0.75,
          '& > *': { flexShrink: 0 },
          '& .MuiAccordionSummary-root': { minHeight: 30, px: 0.5 },
          '& .MuiAccordionSummary-content': { my: 0.5 },
        }}>
          <TextField select fullWidth size="small" label="日期" value={weekday}
            disabled={!days.length} onChange={event => onDayChange(event.target.value)}>
            {days.map(day => <MenuItem key={day.weekday} value={day.weekday}>{day.label}（{day.weekday}）</MenuItem>)}
          </TextField>
          <FormControlLabel label="PDF 原图" sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
            control={<Switch size="small" checked={pdfVisible}
            onChange={(_, checked) => { setPdfVisible(checked); setPdfError(null) }} />} />
          {pdfVisible && !pdfError && halls.some(hall => !pdfImages.has(hall))
            && <LinearProgress aria-label="加载 PDF 原图" />}
          {pdfVisible && pdfError && <Alert severity="warning" action={<Button onClick={() => {
            setPdfError(null); setPdfAttempt(value => value + 1)
          }}>重试</Button>}>{pdfError}</Alert>}
          <Box>
            <Typography id="map-rotation-label" variant="body2">rotation</Typography>
            <Slider size="small" aria-labelledby="map-rotation-label" value={rotation} min={-180} max={180}
              step={1} valueLabelDisplay="auto" valueLabelFormat={value => `${Math.round(value)}°`}
              onChange={(_, value) => {
                if (typeof value === 'number') setRotation(value)
              }} />
          </Box>
          <Accordion disableGutters elevation={0}>
            <AccordionSummary aria-controls="map-level-options" id="map-level-label"
              expandIcon={<Box sx={{ width: 7, height: 7, borderRight: '1px solid', borderBottom: '1px solid',
                transform: 'rotate(45deg)' }} />}>
              <Typography variant="body2">level</Typography>
            </AccordionSummary>
            <AccordionDetails id="map-level-options" sx={{ p: 0 }}>
              <FormGroup row aria-labelledby="map-level-label" sx={{ '& .MuiFormControlLabel-root': { m: 0, minHeight: 28 },
                '& .MuiCheckbox-root': { p: 0.5 }, '& .MuiFormControlLabel-label': { fontSize: 13 } }}>
                {[1, 2, 3, 4].map(level => (
                  <FormControlLabel key={level} label={String(level)}
                    control={<Checkbox size="small" checked={levels.includes(level)} onChange={(_, checked) => {
                      setLevels(previous => checked ? [...previous, level] : previous.filter(value => value !== level))
                    }} />} />
                ))}
              </FormGroup>
            </AccordionDetails>
          </Accordion>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography component={genreEnabled ? 'button' : 'span'} variant="body2"
              type={genreEnabled ? 'button' : undefined}
              aria-haspopup={genreEnabled ? 'dialog' : undefined}
              aria-expanded={genreEnabled ? genreAnchor !== null : undefined}
              aria-controls={genreAnchor ? 'map-genre-options' : undefined}
              onClick={genreEnabled ? (event: MouseEvent<HTMLElement>) => setGenreAnchor(event.currentTarget) : undefined}
              sx={{
                display: 'flex', alignItems: 'center', flex: 1, height: 30, px: 0.5,
                border: 0, borderRadius: 1, color: 'text.primary',
                bgcolor: genreEnabled ? 'action.hover' : 'transparent',
                ...(genreEnabled && { cursor: 'pointer', '&:hover': { bgcolor: 'action.selected' } }),
              }}>genre</Typography>
            <Checkbox size="small" checked={genreEnabled} sx={{ p: 0.5 }}
              slotProps={{ input: { 'aria-label': '启用 genre 上色' } }}
              onChange={(_, checked) => {
                setGenreEnabled(checked)
                if (!checked) setGenreAnchor(null)
              }} />
          </Box>
          <Popover open={genreEnabled && genreAnchor !== null} anchorEl={genreAnchor} onClose={() => setGenreAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            slotProps={{ paper: { id: 'map-genre-options', role: 'dialog', 'aria-labelledby': 'map-genre-title',
              sx: { p: 1.5, maxWidth: 'min(560px, calc(100vw - 32px))', maxHeight: '65vh' } } }}>
            <Typography id="map-genre-title" variant="subtitle2">genre（社团数）</Typography>
            {!boothData?.genreReady ? (
              <Typography variant="caption" color="warning.main">请先在 Crawler 整理 genre 数据</Typography>
            ) : <>
              <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                <Button size="small" onClick={() => setSelectedGenres(null)}>全部上色</Button>
                <Button size="small" onClick={() => setSelectedGenres([])}>全部取消</Button>
              </Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                {boothData.genres.map(genre => {
                  const active = selectedGenres === null || selectedGenres.includes(genre.key)
                  return <Chip key={genre.key} size="small" label={`${genre.name || '未分类'}（${genre.count}）`}
                    title={genre.code ? `genre code: ${genre.code}` : '无 genre code'}
                    aria-pressed={active} variant={active ? 'filled' : 'outlined'}
                    icon={<Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: genre.color }} />}
                    onClick={() => setSelectedGenres(previous => previous === null ? [genre.key]
                      : previous.includes(genre.key) ? previous.filter(key => key !== genre.key) : [...previous, genre.key])} />
                })}
              </Box>
            </>}
          </Popover>
          {!!data.namedRoutes?.length && (
            <Accordion disableGutters elevation={0}>
              <AccordionSummary aria-controls="map-route-options" id="map-routes-label"
                expandIcon={<Box sx={{ width: 7, height: 7, borderRight: '1px solid', borderBottom: '1px solid',
                  transform: 'rotate(45deg)' }} />}>
                <Typography variant="body2">routes</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 0 }}>
                <FormGroup aria-labelledby="map-routes-label" sx={{ '& .MuiFormControlLabel-root': { m: 0, minHeight: 28 },
                  '& .MuiCheckbox-root': { p: 0.5 }, '& .MuiFormControlLabel-label': { fontSize: 12 } }}>
                  {data.namedRoutes.map(({ id, name, hall }) => (
                    <FormControlLabel key={id} label={name}
                      control={<Checkbox size="small" checked={selectedRoutes.has(id)}
                        sx={{ '&.Mui-checked': { color: hallRouteColor(hall) } }}
                        onChange={(_, checked) => setSelectedRoutes(previous => {
                          const next = new Set(previous)
                          if (checked) next.add(id)
                          else next.delete(id)
                          return next
                        })} />} />
                  ))}
                </FormGroup>
              </AccordionDetails>
            </Accordion>
          )}
          <Typography variant="caption" component="div" sx={{
            color: 'text.secondary', overflowWrap: 'anywhere', minHeight: '1.5em',
          }}>
            {hoverLabel || '—'}
          </Typography>
        </Paper>
        <Box sx={{ position: 'absolute', right: 16, bottom: 8, bgcolor: 'rgba(255,255,255,0.9)', px: 0.5 }}>
          <Typography variant="caption">
            © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
          </Typography>
        </Box>
      </Box>
  )
}
