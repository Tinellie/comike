import { useEffect, useState } from 'react'
import { Alert, Button, CircularProgress, Stack, Typography } from '@mui/material'
import OsmCanvas from '../map/OsmCanvas'
import { parseOsm } from '../map/osm'
import type { OsmMapData } from '../map/osm'

export default function Map() {
  const [data, setData] = useState<OsmMapData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    async function load() {
      try {
        const response = await fetch('/api/map/osm-map.osm', { signal: controller.signal })
        if (!response.ok) throw new Error(`OSM 地图加载失败（HTTP ${response.status}），请检查 ref/osm-map.osm`)
        const map = parseOsm(await response.text())
        if (active) {
          for (const warning of map.warnings) console.warn('OSM geometry:', warning)
          setData(map)
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
      {data && (
        <>
          {data.warnings.length > 0 && <Alert severity="warning">{data.warnings.join(' ')}</Alert>}
          <OsmCanvas data={data} />
        </>
      )}
    </Stack>
  )
}
