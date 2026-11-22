import { useEffect, useState } from 'react'
import { Alert, Box, Button, LinearProgress } from '@mui/material'
import OsmBasemap from '../map/basemap/OsmBasemap'
import type { BasemapData } from '../map/basemap/BasemapRenderer'
import { parseOsm } from '../map/osm'

export default function Map2() {
  const [data, setData] = useState<BasemapData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/map/ref.osm', { signal: controller.signal })
        if (!response.ok) throw new Error(`ref.osm 加载失败（HTTP ${response.status}）`)
        const xml = await response.text()
        if (!controller.signal.aborted) setData(parseOsm(xml))
      } catch (reason) {
        if (controller.signal.aborted) return
        console.error('Map2 loading failed:', reason)
        setError(reason instanceof Error ? reason.message : 'ref.osm 加载失败')
      }
    }
    void load()
    return () => controller.abort()
  }, [attempt])

  return <Box sx={{
    display: 'flex', flexDirection: 'column',
    height: { xs: 'calc(100dvh - 56px)', sm: 'calc(100dvh - 64px)' },
  }}>
    {error ? <Alert severity="error" action={<Button size="small" onClick={() => {
      setData(null)
      setError(null)
      setAttempt(value => value + 1)
    }}>重试</Button>}>{error}</Alert>
      : data ? <OsmBasemap data={data} onError={setError} /> : <LinearProgress aria-label="加载地图" />}
  </Box>
}
