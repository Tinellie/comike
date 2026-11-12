import { useEffect, useState } from 'react'
import { Box, Button } from '@mui/material'
import OsmCanvas from '../map/OsmCanvas'
import { parseOsm } from '../map/osm'
import type { OsmMapData } from '../map/osm'
import { parseHalls, parseHallTransforms } from '../map/halls'
import type { HallTransforms, MapHall } from '../map/halls'
import { recalculateHallTransforms } from '../map/hallPreparation'

export default function Map() {
  const [data, setData] = useState<OsmMapData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [halls, setHalls] = useState<MapHall[]>([])
  const [transforms, setTransforms] = useState<HallTransforms | null>(null)
  const [saving, setSaving] = useState(false)

  async function recalculateTransforms() {
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
      <Button variant="contained" onClick={() => { void recalculateTransforms() }}
        disabled={saving || (!data && !error)} color={error ? 'error' : 'primary'}
        aria-busy={saving}
        title={error ?? undefined} aria-label={error ? `重新计算全部 Hall：${error}，点击重试` : undefined}
        sx={{ position: 'absolute', top: 16, right: 16, zIndex: 1 }}>
        {saving ? '计算并保存中…' : error ? '重新计算全部 Hall（失败，重试）' : '重新计算全部 Hall'}
      </Button>
      {data && transforms && (
        <OsmCanvas data={data} halls={halls} transforms={transforms} onError={setError} />
      )}
    </Box>
  )
}
