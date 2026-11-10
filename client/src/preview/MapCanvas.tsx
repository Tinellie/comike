import { useEffect, useRef, useState } from 'react'
import { Alert, Box, LinearProgress } from '@mui/material'
import type { PreviewPage } from './data'
import type { PreviewOptions } from './layers'
import { MapPreviewRenderer } from './MapPreviewRenderer'

interface MapCanvasProps {
  page: PreviewPage
  options: PreviewOptions
  zoom: number | 'fit'
}

export default function MapCanvas({ page, options, zoom }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [availableWidth, setAvailableWidth] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let objectUrl: string | undefined
    async function load() {
      try {
        const response = await fetch(`/api/preview/${page.image}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`背景图片加载失败（HTTP ${response.status}）`)
        const blob = await response.blob()
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        const background = new Image()
        background.src = objectUrl
        await background.decode()
        if (background.naturalWidth !== page.width || background.naturalHeight !== page.height) {
          throw new Error('背景图片尺寸与识别坐标不一致，请重新生成识别输出')
        }
        if (active) setImage(background)
      } catch (reason) {
        if (active) {
          console.error('Map image loading failed:', reason)
          setError(reason instanceof Error ? reason.message : '背景图片加载失败')
        }
      }
    }
    void load()
    return () => {
      active = false
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [page.image, page.width, page.height])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || availableWidth <= 0) return
    let renderer: MapPreviewRenderer | undefined
    const frame = requestAnimationFrame(() => {
      try {
        renderer = new MapPreviewRenderer(canvas)
        renderer.draw(page, image, options, zoom === 'fit' ? availableWidth : page.width * zoom)
      } catch (reason) {
        console.error('Map rendering failed:', reason)
        setError(reason instanceof Error ? reason.message : '地图绘制失败')
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      renderer?.dispose()
    }
  }, [page, image, options, zoom, availableWidth])

  return (
    <Box ref={containerRef} sx={{ width: '100%', minWidth: 0 }}>
      {error && <Alert severity="error">{error}</Alert>}
      {!image && !error && <LinearProgress aria-label="加载地图背景" />}
      <Box sx={{ overflow: 'auto', maxHeight: '75vh', bgcolor: '#eceff1', border: '1px solid', borderColor: 'divider' }}>
        <canvas
          ref={canvasRef}
          aria-label={`第 ${page.page} 页地图，${page.booths.length} 个识别图格`}
          role="img"
          style={{ display: image && !error ? 'block' : 'none' }}
        />
      </Box>
    </Box>
  )
}
