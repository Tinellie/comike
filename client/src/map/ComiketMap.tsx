import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox, FormControlLabel,
  Chip, FormGroup, IconButton, LinearProgress, MenuItem, Paper, Popover, Switch, TextField, Typography,
} from '@mui/material'
import type { OsmMapData } from './osm'
import { ComiketMapLayer } from './ComiketMapLayer'
import type { MapBoothHit, RouteListStop } from './ComiketMapLayer'
import type { HallTransforms, MapHall } from './halls'
import { defaultHallDisplay, hallRouteColor } from './HallMapLayer'
import OsmBasemap from './basemap/OsmBasemap'
import type { BasemapRenderer, BasemapLayer } from './basemap/BasemapRenderer'
import { mapStyle, onewayTriangles } from './style'
import type { MapBoothData, MapBoothLocation, MapFavorite } from '../booths/api'
import { requestColours, saveColourCoefficient } from '../booths/colourApi'
import type { ColourPriority } from '../booths/colourApi'
import BoothHoverPreview from './BoothHoverPreview'
import type { BoothHoverHandle } from './BoothHoverPreview'
import { mapBoothKey } from './boothLookup'
import type { FavoriteHighlights } from './favoriteHighlights'
import type { PlannerSide } from './navigation'
import RouteList from './RouteList'

const comiketStyle = {
  feature: mapStyle,
  arrows: (feature: OsmMapData['features'][number], metersPerUnit: number) =>
    onewayTriangles(feature.paths, feature.tags, metersPerUnit),
}

interface ComiketMapProps {
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
  favorites: MapFavorite[]
  favoriteScope: string
  onRecolourFavorite: (boothId: string, colour: string) => Promise<void>
  userId?: string
  loadBooth: (hit: MapBoothHit) => Promise<MapBoothLocation>
  loadBoothDetails: (hit: MapBoothHit) => Promise<MapBoothLocation>
}

export default function ComiketMap({ data, halls, transforms, routesVisible, onError, onBoothClick, days, weekday, onDayChange, boothData, favoriteHighlights, favorites, favoriteScope, onRecolourFavorite, userId, loadBooth, loadBoothDetails }: ComiketMapProps) {
  const routeCanvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<ComiketMapLayer | null>(null)
  const hallState = useRef({ halls, transforms })
  const [levels, setLevels] = useState<number[]>([1, 2])
  const [hoverLabel, setHoverLabel] = useState('')
  const [mapHover, setMapHover] = useState<{ hit: MapBoothHit; colour?: string } | null>(null)
  const [genreEnabled, setGenreEnabled] = useState(false)
  const [selectedGenres, setSelectedGenres] = useState<string[] | null>(null)
  const [genreAnchor, setGenreAnchor] = useState<HTMLElement | null>(null)
  const genreState = useRef({ enabled: genreEnabled, selected: selectedGenres })
  const tooltipRef = useRef<BoothHoverHandle | null>(null)
  const [pdfVisible, setPdfVisible] = useState(false)
  const routesState = useRef(routesVisible)
  const [selectedRoutes, setSelectedRoutes] = useState<ReadonlySet<string>>(() => new Set())
  const selectedRoutesState = useRef(selectedRoutes)
  const [plannerSide, setPlannerSide] = useState<PlannerSide>('東')
  const [routeStops, setRouteStops] = useState<RouteListStop[]>([])
  const [inspectedStop, setInspectedStop] = useState<RouteListStop | null>(null)
  const [colourMenu, setColourMenu] = useState<{
    scope: string; boothId: string; left: number; top: number; saving?: boolean; error?: string
  } | null>(null)
  const currentMenu = colourMenu?.scope === favoriteScope ? colourMenu : null
  const menuFavorite = favorites.find(favorite => favorite.boothId === currentMenu?.boothId)
  const hoverHit = mapHover?.hit
  const hoveredRouteStop = hoverHit && (routeStops.find(stop => stop.suffix === hoverHit.suffix
    && mapBoothKey(stop.hit) === mapBoothKey(hoverHit))
    ?? routeStops.find(({ hit, suffix }) => suffix === 'ab'
      && mapBoothKey({ ...hit, suffix: hoverHit.suffix }) === mapBoothKey(hoverHit)))
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [coefficientsOpen, setCoefficientsOpen] = useState(false)
  const [colourAttempt, setColourAttempt] = useState(0)
  const [plannerColours, setPlannerColours] = useState<{ userId: string; colours: ColourPriority[]; error?: string } | null>(null)
  const [coefficientDraft, setCoefficientDraft] = useState<{ userId: string; values: ReadonlyMap<string, string> } | null>(null)
  const [saveErrors, setSaveErrors] = useState<{ userId: string; values: ReadonlyMap<string, string> } | null>(null)
  const saveScope = useRef<AbortSignal | null>(null)
  const saves = useRef(new Map<string, Promise<void>>())
  const colourConfig = plannerColours?.userId === userId ? plannerColours : null
  const drafts = coefficientDraft?.userId === userId ? coefficientDraft?.values : undefined
  const invalidCoefficient = (value: string) => {
    const number = Number(value)
    return !value.trim() || !Number.isFinite(number) || (number !== 0 && (number < 0.01 || number > 1000))
  }
  const [plannerIssue, setPlannerIssue] = useState<{ message: string; favorites: FavoriteHighlights; transforms: HallTransforms } | null>(null)
  const plannerColor = plannerSide === '東' ? hallRouteColor('東')
    : `linear-gradient(90deg, ${hallRouteColor('西')} 50%, ${hallRouteColor('南')} 50%)`
  const [pdfImages, setPdfImages] = useState<ReadonlyMap<MapHall, HTMLImageElement>>(new Map())
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [pdfAttempt, setPdfAttempt] = useState(0)
  const pdfCache = useRef(new WeakMap<MapHall, HTMLImageElement>())
  const pdfState = useRef<ReadonlyMap<MapHall, HTMLImageElement>>(new Map())
  const levelsState = useRef(levels)
  const clickHandler = useRef(onBoothClick)
  const boothState = useRef(boothData)
  const favoriteState = useRef(favoriteHighlights)
  const previousFavoriteScope = useRef(favoriteScope)
  useEffect(() => { clickHandler.current = onBoothClick }, [onBoothClick])

  function openColourMenu(event: MouseEvent, hit: MapBoothHit, suffix?: RouteListStop['suffix']) {
    if (!userId) return
    const matches = favorites.filter(favorite => favorite.hallGroup === hit.hallGroup
      && favorite.island.normalize('NFKC') === hit.island.normalize('NFKC')
      && favorite.number.padStart(2, '0') === hit.number.padStart(2, '0'))
    const favorite = matches.find(item => item.suffix === (suffix ?? hit.suffix))
      ?? (suffix === undefined ? matches.find(item => item.suffix === 'ab') : undefined)
    if (!favorite) return
    event.preventDefault()
    inspectStop(null)
    rendererRef.current?.setPointer(null)
    setMapHover(null)
    setColourMenu({ scope: favoriteScope, boothId: favorite.boothId, left: event.clientX, top: event.clientY })
  }

  async function chooseFavouriteColour(colour: string) {
    if (!currentMenu || currentMenu.saving) return
    const pending = { ...currentMenu, saving: true, error: undefined }
    setColourMenu(pending)
    try {
      await onRecolourFavorite(currentMenu.boothId, colour)
      setColourMenu(menu => menu === pending ? null : menu)
    } catch (reason) {
      console.error('Map favorite colour saving failed:', reason)
      setColourMenu(menu => menu === pending ? { ...currentMenu,
        error: reason instanceof Error ? reason.message : '收藏颜色保存失败' } : menu)
    }
  }

  function inspectStop(stop: RouteListStop | null) {
    const renderer = rendererRef.current
    renderer?.inspectPlannedStop(stop)
    const point = renderer?.plannedStopAnchor()
    if (point) tooltipRef.current?.move(point.x, point.y)
    setInspectedStop(stop)
  }

  useEffect(() => {
    const controller = new AbortController()
    saveScope.current = controller.signal
    return () => controller.abort()
  }, [userId])

  function persistCoefficient(owner: string, colour: string, coefficient: number) {
    const scope = saveScope.current
    const key = `${owner}:${colour}`
    async function save() {
      if (!scope || scope.aborted) return
      let error: string | undefined
      try {
        await saveColourCoefficient(colour, coefficient)
      } catch (reason) {
        console.error('Planner coefficient saving failed:', reason)
        error = reason instanceof Error ? reason.message : '颜色系数保存失败'
      }
      if (scope.aborted) return
      setSaveErrors(previous => {
        const values = new Map(previous?.userId === owner ? previous.values : [])
        if (error) values.set(colour, error)
        else values.delete(colour)
        return { userId: owner, values }
      })
    }
    const previous = saves.current.get(key)
    const pending = previous ? previous.then(save) : save()
    saves.current.set(key, pending)
    void pending.then(() => {
      if (saves.current.get(key) === pending) saves.current.delete(key)
    })
  }

  useEffect(() => {
    if (!userId) return
    const controller = new AbortController()
    void requestColours(controller.signal).then(entries => {
      if (!controller.signal.aborted) setPlannerColours({ userId, colours: entries })
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        console.error('Planner colour preferences loading failed:', reason)
        setPlannerColours({ userId, colours: [], error: reason instanceof Error ? reason.message : '颜色配置加载失败' })
      }
    })
    return () => controller.abort()
  }, [userId, colourAttempt])

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
    const previous = favoriteState.current
    const preserveRoute = previousFavoriteScope.current === favoriteScope
      && previous.stops.length === favoriteHighlights.stops.length
      && previous.stops.every((stop, index) => stop.bbox === favoriteHighlights.stops[index].bbox
        && stop.hallIndex === favoriteHighlights.stops[index].hallIndex)
    favoriteState.current = favoriteHighlights
    previousFavoriteScope.current = favoriteScope
    rendererRef.current?.setFavoriteHighlights(favoriteHighlights, preserveRoute)
  }, [favoriteHighlights, favoriteScope])

  useEffect(() => {
    levelsState.current = levels
    rendererRef.current?.setLevels(levels)
  }, [levels])

  useEffect(() => {
    hallState.current = { halls, transforms }
    rendererRef.current?.setHalls(halls, transforms, defaultHallDisplay, null)
  }, [halls, transforms])

  const attachLayer = useCallback((map: BasemapRenderer): BasemapLayer => {
    const routeCanvas = routeCanvasRef.current
    if (!routeCanvas) throw new Error('路线画布尚未就绪')
    let dragging = false
    const renderer = new ComiketMapLayer(map, routeCanvas, data, (label, canClick, hit, colour) => {
      setHoverLabel(label)
      if (!dragging) map.canvas.style.cursor = canClick ? 'pointer' : 'grab'
      setMapHover(previous => {
        if (dragging || !hit) return null
        if (previous && mapBoothKey(previous.hit) === mapBoothKey(hit)) {
          return previous.colour === colour ? previous : { hit: previous.hit, colour }
        }
        return { hit, colour }
      })
    }, stops => {
      setRouteStops(stops)
      setReorderError(null)
      if (!stops.length) setInspectedStop(null)
    })
    const state = hallState.current
    renderer.setHalls(state.halls, state.transforms, defaultHallDisplay, null)
    renderer.setLevels(levelsState.current)
    renderer.setBoothData(boothState.current)
    renderer.setFavoriteHighlights(favoriteState.current)
    renderer.setGenreDisplay(genreState.current.enabled, genreState.current.selected)
    renderer.setPdfImages(pdfState.current)
    renderer.setRoutesVisible(routesState.current)
    renderer.setSelectedRoutes(selectedRoutesState.current)
    rendererRef.current = renderer
    return {
      resize: (width, height) => renderer.resize(width, height),
      fitBounds: () => renderer.fitBounds(),
      prepare: frame => {
        const point = renderer.plannedStopAnchor()
        if (point) tooltipRef.current?.move(point.x, point.y)
        return renderer.prepare(frame)
      },
      pointer: point => {
        dragging = point?.dragging ?? false
        if (!point || dragging) setMapHover(null)
        if (point) tooltipRef.current?.move(point.client.x, point.client.y)
        renderer.setPointer(point?.screen ?? null)
      },
      click: point => {
        const hit = renderer.pickBooth(point.screen)
        if (hit) clickHandler.current(hit)
      },
      keyDown: event => {
        if (event.defaultPrevented || event.repeat || event.isComposing
          || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || (event.target instanceof HTMLElement
            && (event.target.isContentEditable || event.target.closest('input, textarea, select, button, a, [role="combobox"]')))) return
        if (event.code === 'Space') {
          if (!renderer.selectNavigationPoint()) return
        } else if (event.key.toLowerCase() === 'x' && renderer.hasNavigationSelection()) {
          renderer.clearNavigation()
          setPlannerIssue(null)
        } else return
        event.preventDefault()
      },
      dispose: () => {
        renderer.dispose()
        rendererRef.current = null
        setRouteStops([])
        setInspectedStop(null)
        setMapHover(null)
      },
    }
  }, [data])

  return (
      <OsmBasemap data={data} mapStyle={comiketStyle} attachLayer={attachLayer} onError={onError}
        onContextMenu={event => {
          const { left, top } = event.currentTarget.getBoundingClientRect()
          const hit = rendererRef.current?.pickBooth({ x: event.clientX - left, y: event.clientY - top })
          if (hit) openColourMenu(event, hit)
        }}>
        {controls => <>
        <BoothHoverPreview ref={tooltipRef} hit={currentMenu ? null : inspectedStop?.hit ?? (boothData ? hoverHit ?? null : null)}
          colour={inspectedStop?.colour ?? mapHover?.colour} load={loadBooth} />
        <canvas ref={routeCanvasRef} aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
        {!!routeStops.length && <RouteList stops={routeStops} load={loadBoothDetails} error={reorderError}
          hoveredStopId={hoveredRouteStop?.id}
          onContextMenu={(event, stop) => openColourMenu(event, stop.hit, stop.suffix)}
          onInspect={inspectStop} onReorder={(from, to) => {
            setReorderError(rendererRef.current?.reorderPlannedRoute(from, to) ?? null)
          }} />}
        {currentMenu && menuFavorite && <Popover open anchorReference="anchorPosition" anchorPosition={currentMenu}
          onClose={() => { if (!currentMenu.saving) setColourMenu(null) }}>
          <Box role="dialog" aria-label="收藏颜色" aria-busy={currentMenu.saving} sx={{ p: 1 }}>
            {!colourConfig && <LinearProgress aria-label="加载颜色配置" />}
            {colourConfig?.error && <Alert severity="error" action={<Button size="small" onClick={() => {
              setPlannerColours(null)
              setColourAttempt(attempt => attempt + 1)
            }}>重试</Button>}>{colourConfig.error}</Alert>}
            {colourConfig && !colourConfig.error && <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, maxWidth: 248 }}>
              {[...new Set([...colourConfig.colours.map(entry => entry.colour), menuFavorite.colour])].map(colour =>
                <IconButton key={colour} size="small" aria-label={colour} aria-pressed={menuFavorite.colour === colour}
                  disabled={currentMenu.saving} onClick={() => { void chooseFavouriteColour(colour) }}>
                  <Box sx={{ width: 18, height: 18, borderRadius: '50%', bgcolor: colour,
                    outline: menuFavorite.colour === colour ? '2px solid' : '1px solid', outlineOffset: 2,
                    outlineColor: menuFavorite.colour === colour ? 'text.primary' : 'divider' }} />
                </IconButton>)}
            </Box>}
            {currentMenu.error && <Alert severity="error" sx={{ mt: 0.5 }}>{currentMenu.error}</Alert>}
          </Box>
        </Popover>}
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
          {controls}
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
          <Box role="group" aria-labelledby="map-planner-label">
            <Typography id="map-planner-label" variant="body2" sx={{ px: 0.5 }}>planner</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5 }}>
              <Typography variant="body2" sx={{ fontWeight: plannerSide === '東' ? 700 : 400 }}>東</Typography>
              <Switch size="small" checked={plannerSide === '西南'}
                onChange={(_, checked) => {
                  setPlannerSide(checked ? '西南' : '東')
                  setPlannerIssue(null)
                  rendererRef.current?.clearPlannedRoute()
                }}
                slotProps={{ input: { role: 'switch', 'aria-label': 'planner：東 / 西南' } }}
                sx={{
                  '& .MuiSwitch-thumb': { background: plannerColor },
                  '& .MuiSwitch-track, & .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
                    background: plannerColor, opacity: 0.35,
                  },
                }} />
              <Typography variant="body2" sx={{ fontWeight: plannerSide === '西南' ? 700 : 400 }}>西南</Typography>
            </Box>
            {userId && (
              <Accordion disableGutters elevation={0} expanded={coefficientsOpen}
                onChange={(_, expanded) => setCoefficientsOpen(expanded)}>
                <AccordionSummary aria-controls="map-planner-coefficients" id="map-planner-coefficients-label"
                  expandIcon={<Box sx={{ width: 7, height: 7, borderRight: '1px solid', borderBottom: '1px solid',
                    transform: 'rotate(45deg)' }} />}>
                  <Typography variant="body2">颜色系数</Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0.5, display: 'grid', gap: 0.5 }}>
                  {!colourConfig && <LinearProgress aria-label="加载颜色系数" />}
                  {colourConfig?.error && (
                    <Alert severity="warning" action={<Button size="small" onClick={() => {
                      setPlannerColours(null)
                      setColourAttempt(value => value + 1)
                    }}>重试</Button>}>{colourConfig.error}</Alert>
                  )}
                  {colourConfig?.colours.map(({ colour, coefficient }) => {
                    const value = drafts?.get(colour) ?? String(coefficient)
                    const saveError = saveErrors?.userId === userId ? saveErrors?.values.get(colour) : undefined
                    return (
                      <Box key={colour}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                        <Box title={colour} sx={{ width: 18, height: 18, border: '1px solid', borderColor: 'divider', bgcolor: colour }} />
                        <TextField size="small" type="number" value={value} error={invalidCoefficient(value)}
                          sx={{ width: 84 }} slotProps={{ htmlInput: { 'aria-label': `${colour} 系数`, min: 0, max: 1000, step: 'any' } }}
                          onChange={event => {
                            const nextValue = event.target.value
                            setCoefficientDraft(previous => ({
                              userId, values: new Map([...(previous?.userId === userId ? previous.values : []), [colour, nextValue]]),
                            }))
                            if (!invalidCoefficient(nextValue)) persistCoefficient(userId, colour, Number(nextValue))
                          }} />
                      </Box>
                      {saveError && <Alert severity="warning" action={<Button size="small" disabled={invalidCoefficient(value)}
                        onClick={() => persistCoefficient(userId, colour, Number(value))}>重试</Button>}>{saveError}</Alert>}
                      </Box>
                    )
                  })}
                </AccordionDetails>
              </Accordion>
            )}
            <Button size="small" fullWidth disabled={Boolean(userId && (!colourConfig || colourConfig.error))
              || colourConfig?.colours.some(({ colour, coefficient }) => invalidCoefficient(drafts?.get(colour) ?? String(coefficient)))} onClick={() => {
              const coefficients = new Map(colourConfig?.colours.map(({ colour, coefficient }) => [colour, Number(drafts?.get(colour) ?? coefficient)]))
              const message = rendererRef.current ? rendererRef.current.planFavoriteRoute(plannerSide, coefficients) : '地图尚未就绪。'
              setPlannerIssue(message ? { message, favorites: favoriteHighlights, transforms } : null)
            }}>cal route</Button>
            {plannerIssue?.favorites === favoriteHighlights && plannerIssue.transforms === transforms && (
              <Typography variant="caption" component="div" role="status" color="warning.dark" sx={{ px: 0.5 }}>
                {plannerIssue.message}
              </Typography>
            )}
          </Box>
          <Typography variant="caption" component="div" sx={{
            color: 'text.secondary', overflowWrap: 'anywhere', minHeight: '1.5em',
          }}>
            {hoverLabel || '—'}
          </Typography>
        </Paper>
        </>}
      </OsmBasemap>
  )
}
