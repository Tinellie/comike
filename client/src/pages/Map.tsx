import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, LinearProgress, Stack } from '@mui/material'
import OsmCanvas from '../map/OsmCanvas'
import { parseOsm } from '../map/osm'
import type { OsmMapData } from '../map/osm'
import { parseHalls, parseHallTransforms } from '../map/halls'
import type { HallTransforms, MapHall } from '../map/halls'
import { recalculateHallTransforms } from '../map/hallPreparation'
import type { MapBoothHit } from '../map/OsmMapRenderer'
import BoothDetail from '../booths/BoothDetail'
import { readBoothApi } from '../booths/api'
import type { BoothDays, BoothDetail as Detail, MapBoothData, MapVacancy } from '../booths/api'
import { MapBoothLookup } from '../map/boothLookup'
import { useAuth } from '../auth/context'

export default function Map() {
  const { user } = useAuth()
  const [data, setData] = useState<OsmMapData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [halls, setHalls] = useState<MapHall[]>([])
  const [transforms, setTransforms] = useState<HallTransforms | null>(null)
  const [saving, setSaving] = useState(false)
  const [options, setOptions] = useState<BoothDays | null>(null)
  const [weekday, setWeekday] = useState('')
  const [circles, setCircles] = useState<Detail[]>([])
  const [selected, setSelected] = useState<Detail | null>(null)
  const [vacancy, setVacancy] = useState<MapVacancy | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [dayAttempt, setDayAttempt] = useState(0)
  const [mapAttempt, setMapAttempt] = useState(0)
  const [preload, setPreload] = useState<{ eventId: string; weekday: string; data: MapBoothData } | null>(null)
  const [preloadError, setPreloadError] = useState<string | null>(null)
  const eventId = options?.event?.eventId
  const boothData = preload?.eventId === eventId && preload?.weekday === weekday ? preload.data : null
  const lookup = useRef<AbortController | null>(null)
  const lastHit = useRef<MapBoothHit | null>(null)
  const locationLookup = useMemo(() => new MapBoothLookup(eventId ?? '', weekday), [eventId, weekday])
  useEffect(() => () => locationLookup.dispose(), [locationLookup])

  useEffect(() => {
    const controller = new AbortController()
    void readBoothApi<BoothDays>('/days', controller.signal).then(result => {
      if (controller.signal.aborted) return
      setOptions(result)
      setWeekday(result.days[0]?.weekday ?? '')
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      console.error('Map day options failed:', reason)
      setLookupError(reason instanceof Error ? reason.message : '日目读取失败')
    })
    return () => { controller.abort(); lookup.current?.abort() }
  }, [dayAttempt])

  useEffect(() => {
    if (!eventId || !weekday) return
    const controller = new AbortController()
    const query = new URLSearchParams({ eventId, weekday })
    void readBoothApi<MapBoothData>(`/map-data?${query}`, controller.signal).then(data => {
      if (controller.signal.aborted) return
      setPreload({ eventId, weekday, data })
      setPreloadError(null)
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      console.error('Map booth preload failed:', reason)
      setPreloadError(reason instanceof Error ? reason.message : '地图摊位预加载失败')
    })
    return () => controller.abort()
  }, [eventId, weekday, mapAttempt])

  function changeDay(value: string) {
    lookup.current?.abort()
    lastHit.current = null
    setPreloadError(null)
    setWeekday(value); setSelected(null); setVacancy(null); setCircles([]); setLookingUp(false); setLookupError(null)
  }

  async function selectBooth(hit: MapBoothHit) {
    lookup.current?.abort()
    lastHit.current = hit
    if (!options?.event || !weekday) {
      setLookupError('没有可用的活动或日目，请先采集社团数据')
      return
    }
    const controller = new AbortController()
    lookup.current = controller
    setLookingUp(true); setLookupError(null); setSelected(null); setVacancy(null); setCircles([])
    try {
      const result = await locationLookup.load(hit)
      if (controller.signal.aborted) return
      setCircles(result.circles); setSelected(result.circles[0] ?? null); setVacancy(result.vacancy)
      if (!result.circles.length && !result.vacancy) setLookupError('此位置没有社团记录或已保存的空位记录，请完成采集并重新执行地图比对')
    } catch (reason) {
      if (controller.signal.aborted) return
      console.error('Map booth lookup failed:', reason)
      setLookupError(reason instanceof Error ? reason.message : '地图位置查询失败')
    } finally {
      if (!controller.signal.aborted) setLookingUp(false)
    }
  }

  async function recalculateTransforms() {
    if (!user?.isAdmin) {
      setError('重新计算全部 Hall 需要管理员权限')
      return
    }
    if (saving) return
    if (!data) {
      setError(null)
      setAttempt(value => value + 1)
      return
    }
    if (!transforms) return
    setSaving(true)
    try {
      const recalculated = recalculateHallTransforms(halls, transforms, data)
      const response = await fetch('/api/map/hall-transforms.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recalculated.transforms),
      })
      if (!response.ok) throw new Error(`Hall 变换保存失败（HTTP ${response.status}）`)
      setTransforms(recalculated.transforms)
      setError(null)
    } catch (reason) {
      console.error('Hall transform recalculation/save failed:', reason)
      setError(reason instanceof Error ? reason.message : 'Hall 变换重新计算或保存失败')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    async function load() {
      try {
        const [response, finalResponse, transformResponse] = await Promise.all([
          fetch('/api/map/osm-map.osm', { signal: controller.signal }),
          fetch('/api/map/final.json', { signal: controller.signal }),
          fetch('/api/map/hall-transforms.json', { signal: controller.signal }),
        ])
        if (!response.ok) throw new Error(`OSM 地图加载失败（HTTP ${response.status}）`)
        if (!finalResponse.ok) throw new Error(`Hall 最终数据加载失败（HTTP ${finalResponse.status}）`)
        if (!transformResponse.ok) throw new Error(`Hall 变换配置加载失败（HTTP ${transformResponse.status}）`)
        const [osmText, finalData, transformData] = await Promise.all([
          response.text(), finalResponse.json(), transformResponse.json(),
        ])
        const map = parseOsm(osmText)
        const loadedHalls = parseHalls(finalData)
        const loadedTransforms = parseHallTransforms(transformData, loadedHalls)
        if (active) {
          for (const warning of map.warnings) console.warn('OSM geometry:', warning)
          setData(map)
          setHalls(loadedHalls)
          setTransforms(loadedTransforms)
        }
      } catch (reason) {
        if (active) {
          console.error('OSM map loading failed:', reason)
          setError(reason instanceof Error ? reason.message : 'OSM 地图加载失败')
        }
      }
    }
    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [attempt])

  return (
    <Box sx={{
      position: 'relative', display: 'flex', flexDirection: 'column',
      height: { xs: 'calc(100dvh - 56px)', sm: 'calc(100dvh - 64px)' },
    }}>
      {user?.isAdmin && <Button variant="contained" onClick={() => { void recalculateTransforms() }}
        disabled={saving || (!data && !error)} color={error ? 'error' : 'primary'}
        aria-busy={saving}
        title={error ?? undefined}
        aria-label={error ? `重新计算全部 Hall：${error}，点击重试` : undefined}
        sx={{ position: 'absolute', top: 16, right: 16, zIndex: 1 }}>
        {saving ? '计算并保存中…' : error ? '重新计算全部 Hall（失败，重试）' : '重新计算全部 Hall'}
      </Button>}
      {data && transforms && (
        <OsmCanvas data={data} halls={halls} transforms={transforms} onError={setError}
          boothData={boothData}
          loadBooth={locationLookup.preview}
          days={options?.days ?? []} weekday={weekday} onDayChange={changeDay} onBoothClick={hit => { void selectBooth(hit) }} />
      )}
      <Stack sx={{ position: 'absolute', top: 16, left: 16, maxWidth: 'min(400px, calc(100% - 32px))', gap: 1 }}>
        {!user?.isAdmin && error && <Alert severity="error" action={<Button onClick={() => {
          setError(null); setAttempt(value => value + 1)
        }}>重试</Button>}>{error}</Alert>}
        {eventId && weekday && !boothData && !preloadError && <LinearProgress aria-label="预加载地图摊位" />}
        {boothData && !boothData.vacancyReady && <Alert severity="warning">请在 Crawler 整理 vacancies 数据，以加载空位合并背景。</Alert>}
        {preloadError && <Alert severity="warning" action={<Button onClick={() => {
          setPreloadError(null); setMapAttempt(value => value + 1)
        }}>重试</Button>}>{preloadError}</Alert>}
        {lookingUp && <LinearProgress aria-label="查询地图社团" />}
        {lookupError && <Alert severity="warning" action={<Button onClick={() => {
          setLookupError(null)
          if (options?.event && weekday && lastHit.current) void selectBooth(lastHit.current)
          else setDayAttempt(value => value + 1)
        }}>重试</Button>}>{lookupError}</Alert>}
      </Stack>
      <BoothDetail key={selected?.id ?? 'no-circle'} booth={selected} vacancy={vacancy}
        initialDetail={selected} alternatives={circles} onSelect={circle => setSelected(circles.find(item => item.id === circle.id) ?? null)}
        onClose={() => { setSelected(null); setVacancy(null); setCircles([]) }} />
    </Box>
  )
}
