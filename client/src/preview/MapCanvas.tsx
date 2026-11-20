import { useEffect, useRef, useState } from 'react'
import { Alert, Box, LinearProgress } from '@mui/material'
import type { PreviewPage } from './data'
import type { PreviewOptions } from './layers'
import { MapPreviewRenderer, previewMargin } from './MapPreviewRenderer'
import { previewSurface } from './pdfPreview'
import { preprocessPdfBackground } from './pdfBackground'
import { parsePathGraph } from './pathGraph'
import type { PathSegment } from './pathGraph'

interface MapCanvasProps {
  page: PreviewPage
  options: PreviewOptions
  zoom: number | 'fit'
}

export default function MapCanvas({ page, options, zoom }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [images, setImages] = useState<{ original: HTMLImageElement; processed: HTMLCanvasElement | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  const [paths, setPaths] = useState<PathSegment[] | null>(null)
  const [pathError, setPathError] = useState<string | null>(null)
  const background = page.pdfPreview ?? page
  const isPdf = !!page.pdfPreview
  const image = (options.preprocessPdf ? images?.processed : null) ?? images?.original

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
        const response = await fetch(`/api/preview/${background.image}`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error(`背景图片加载失败（HTTP ${response.status}）`)
        const blob = await response.blob()
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        const loaded = new Image()
        loaded.src = objectUrl
        await loaded.decode()
        if (!active) return
        if (loaded.naturalWidth !== background.width || loaded.naturalHeight !== background.height) {
          throw new Error('背景图片尺寸与识别坐标不一致，请重新生成识别输出')
        }
        setImages({ original: loaded, processed: isPdf ? preprocessPdfBackground(loaded) : null })
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
  }, [background.image, background.width, background.height, isPdf])

  useEffect(() => {
    if (!options.pathGraph || !page.pdfPreview) return
    const controller = new AbortController()
    const { width, height } = page.pdfPreview
    const load = async () => {
      const name = `page-${String(page.page).padStart(3, '0')}-paths.json`
      const response = await fetch(`/api/preview/${name}`, { signal: controller.signal, cache: 'no-store' })
      if (response.status === 404) throw new Error('此页尚未生成路径图，请重新生成地图数据')
      if (!response.ok) throw new Error(`路径图加载失败（HTTP ${response.status}）`)
      const result = parsePathGraph(await response.json(), width, height)
      if (!controller.signal.aborted) {
        setPaths(result)
        setPathError(null)
      }
    }
    void load().catch((reason: unknown) => {
      if (controller.signal.aborted) return
      console.error('Map path graph loading failed:', reason)
      setPathError(reason instanceof Error ? reason.message : '路径图加载失败')
    })
    return () => controller.abort()
  }, [options.pathGraph, page.page, page.pdfPreview])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !images || !image || availableWidth <= 0) return
    if (images.original.naturalWidth !== background.width || images.original.naturalHeight !== background.height) return
    let renderer: MapPreviewRenderer | undefined
    const frame = requestAnimationFrame(() => {
      try {
        renderer = new MapPreviewRenderer(canvas)
        const viewWidth = previewSurface(page, previewMargin(page, options)).width
        renderer.draw(page, image, options, zoom === 'fit' ? availableWidth : viewWidth * zoom, paths)
      } catch (reason) {
        console.error('Map rendering failed:', reason)
        setError(reason instanceof Error ? reason.message : '地图绘制失败')
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      renderer?.dispose()
    }
  }, [page, images, image, options, zoom, availableWidth, background.width, background.height, paths])

  return (
    <Box ref={containerRef} sx={{ width: '100%', minWidth: 0 }}>
      {error && <Alert severity="error">{error}</Alert>}
      {options.pathGraph && pathError && <Alert severity="error">{pathError}</Alert>}
      {options.pathGraph && !paths && !pathError && <LinearProgress aria-label="加载路径图" />}
      {!image && !error && <LinearProgress aria-label="加载地图背景" />}
      <Box sx={{ overflow: 'auto', maxHeight: '75vh', bgcolor: '#eceff1', border: '1px solid', borderColor: 'divider' }}>
        <canvas
          ref={canvasRef}
          aria-label={`第 ${page.page} 页地图，${page.booths.length} 个识别图格${page.blocks === null ? '' : `，${page.blocks.length} 个 Block`}${page.islandMarkers === null ? '' : `，${page.islandMarkers.length} 个 Island 标记`}${page.islandAssignment === null ? '' : `，${page.islandAssignment.islands.length} 个 Island 分组，${page.islandAssignment.gapCount} 处缺号`}`}
          role="img"
          style={{ display: image && !error ? 'block' : 'none' }}
        />
      </Box>
    </Box>
  )
}
