import { useEffect, useState } from 'react'
import { Alert, Button, CircularProgress, Stack, Typography } from '@mui/material'
import OsmCanvas from '../map/OsmCanvas'
import { parseOsm } from '../map/osm'
import type { OsmMapData } from '../map/osm'
import HallControls from '../map/HallControls'
import { parseHalls, parseHallTransforms } from '../map/halls'
import type { HallPlacement, HallTransforms, MapHall } from '../map/halls'
import { defaultHallDisplay } from '../map/HallMapLayer'
import type { HallDisplay } from '../map/HallMapLayer'

export default function Map() {
  const [data, setData] = useState<OsmMapData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [halls, setHalls] = useState<MapHall[]>([])
  const [transforms, setTransforms] = useState<HallTransforms | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [display, setDisplay] = useState<HallDisplay>(defaultHallDisplay)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function changePlacement(placement: HallPlacement) {
    setTransforms(previous => previous && ({
      ...previous, placements: previous.placements.map(p => p.hallIndex === placement.hallIndex ? placement : p),
    }))
  }

  async function saveTransforms() {
    if (!transforms || saving) return
    const snapshot = JSON.stringify(transforms)
    setSaving(true)
    setSaveError(null)
    try {
      const response = await fetch('/api/map/hall-transforms.json', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: snapshot,
      })
      if (!response.ok) throw new Error(`Hall 变换保存失败（HTTP ${response.status}）`)
      setSavedSnapshot(snapshot)
      setSaved(true)
    } catch (reason) {
      console.error('Hall transform save failed:', reason)
      setSaveError(reason instanceof Error ? reason.message : 'Hall 变换保存失败')
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
          setSavedSnapshot(JSON.stringify(loadedTransforms))
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
    <Stack spacing={2} sx={{
      p: { xs: 2, md: 3 }, boxSizing: 'border-box', minHeight: 440,
      height: { xs: 'calc(100dvh - 56px)', sm: 'calc(100dvh - 64px)' },
    }}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography variant="h5" component="h1">OSM 地图</Typography>
        <Typography variant="body2" color="text.secondary">
          按住鼠标左键拖动 · 滚轮以鼠标位置为中心缩放
        </Typography>
      </Stack>
      {error && (
        <Alert severity="error" action={<Button color="inherit" onClick={() => {
          setError(null)
          setAttempt(value => value + 1)
        }}>重试</Button>}>{error}</Alert>
      )}
      {!data && !error && <CircularProgress aria-label="加载 OSM 地图" />}
      {data && transforms && (
        <>
          {data.warnings.length > 0 && <Alert severity="warning">{data.warnings.join(' ')}</Alert>}
          {saveError && <Alert severity="error">{saveError}</Alert>}
          <HallControls
            halls={halls} transforms={transforms} selected={selected}
            onSelect={index => { setSelected(index); setDragging(false) }} onChange={changePlacement}
            display={display} onDisplay={setDisplay} dragging={dragging} onDragging={setDragging}
            onSave={() => { void saveTransforms() }} saving={saving}
            dirty={JSON.stringify(transforms) !== savedSnapshot} saved={saved}
          />
          <OsmCanvas data={data} halls={halls} transforms={transforms} display={display}
            selectedHall={selected} dragHall={dragging && display.visible} onPlacement={changePlacement} />
        </>
      )}
    </Stack>
  )
}
