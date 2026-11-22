import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { MouseEventHandler, ReactNode } from 'react'
import { Alert, Box, Button, FormControlLabel, LinearProgress, Slider, Switch, Typography } from '@mui/material'
import { dragRotation, projectCoordinate } from '../viewport'
import type { Point } from '../viewport'
import { worldImageryService } from '../satelliteImagery'
import { BasemapRenderer } from './BasemapRenderer'
import type { BasemapData, BasemapLayer, BasemapStyle, MapPointer } from './BasemapRenderer'

interface Props {
  data: BasemapData
  mapStyle?: BasemapStyle
  attachLayer?: (map: BasemapRenderer) => BasemapLayer
  onError?: (message: string) => void
  onContextMenu?: MouseEventHandler<HTMLCanvasElement>
  children?: (controls: ReactNode) => ReactNode
}

export default function OsmBasemap({ data, mapStyle, attachLayer, onError, onContextMenu, children }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<BasemapRenderer | null>(null)
  const [rotation, setRotation] = useState(0)
  const [satelliteVisible, setSatelliteVisible] = useState(false)
  const [satelliteError, setSatelliteError] = useState(false)
  const [locationEnabled, setLocationEnabled] = useState(false)
  const [locationAttempt, setLocationAttempt] = useState(0)
  const [location, setLocation] = useState<{ point: Point } | { error: string } | null>(null)
  const locationPoint = location && 'point' in location ? location.point : null
  const initialize = useEffectEvent((map: BasemapRenderer) => {
    map.setSatelliteVisible(satelliteVisible, setSatelliteError)
    map.setRotation(rotation)
    map.setUserLocation(locationPoint)
  })
  const reportError = useEffectEvent((message: string) => onError?.(message))

  useEffect(() => {
    mapRef.current?.setSatelliteVisible(satelliteVisible, setSatelliteError)
  }, [satelliteVisible])

  useEffect(() => {
    mapRef.current?.setUserLocation(locationPoint)
  }, [locationPoint])

  useEffect(() => {
    if (!locationEnabled) return
    let active = true
    const fail = (error: string) => { if (active) setLocation({ error }) }
    const geolocation = navigator.geolocation
    const request = (enableHighAccuracy: boolean) => {
      geolocation.getCurrentPosition(({ coords }) => {
        if (!active) return
        try {
          setLocation({ point: projectCoordinate(coords.latitude, coords.longitude) })
        } catch {
          fail('浏览器返回的定位坐标无效')
        }
      }, ({ code }) => {
        if (!active) return
        if (enableHighAccuracy && (code === 2 || code === 3)) {
          request(false)
          return
        }
        fail(code === 1 ? '定位权限被拒绝，请在浏览器中允许定位'
          : code === 3 ? '定位超时，请重试' : '定位服务未能提供位置，请检查设备的定位设置')
      }, { enableHighAccuracy, timeout: enableHighAccuracy ? 8_000 : 7_000 })
    }
    if (!window.isSecureContext) fail('定位需要 HTTPS 或 localhost')
    else if (!geolocation) fail('当前浏览器不支持定位')
    else request(true)
    return () => { active = false }
  }, [locationEnabled, locationAttempt])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let map: BasemapRenderer
    let layer: BasemapLayer | undefined
    try {
      map = new BasemapRenderer(canvas, data, mapStyle)
      layer = attachLayer?.(map)
      map.setLayer(layer)
    } catch (reason) {
      console.error('OSM rendering failed:', reason)
      reportError(reason instanceof Error ? reason.message : 'OSM 地图绘制失败')
      return
    }
    mapRef.current = map
    let drag: { id: number; type: string; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null
    let secondTouch: (Point & { id: number }) | null = null
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect()
      map.resize(width, height, window.devicePixelRatio || 1)
    }
    const pointer = (event: MouseEvent): MapPointer => {
      const bounds = canvas.getBoundingClientRect()
      return {
        screen: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        client: { x: event.clientX, y: event.clientY },
        dragging: Boolean(drag),
      }
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (drag) {
        if (drag.type !== 'touch' || event.pointerType !== 'touch' || secondTouch) return
        event.preventDefault()
        canvas.setPointerCapture(event.pointerId)
        secondTouch = { id: event.pointerId, x: event.clientX, y: event.clientY }
        drag.moved = true
        layer?.pointer?.(null)
        return
      }
      event.preventDefault()
      canvas.focus({ preventScroll: true })
      canvas.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, startX: event.clientX,
        startY: event.clientY, moved: event.altKey }
      canvas.style.cursor = event.altKey ? 'crosshair' : 'grabbing'
      layer?.pointer?.(pointer(event))
    }
    const move = (event: PointerEvent) => {
      if (drag && secondTouch) {
        const touch = event.pointerId === drag.id ? drag : event.pointerId === secondTouch.id ? secondTouch : null
        if (!touch) return
        const previousDistance = Math.max(1, Math.hypot(drag.x - secondTouch.x, drag.y - secondTouch.y))
        map.pan((event.clientX - touch.x) / 2, (event.clientY - touch.y) / 2)
        touch.x = event.clientX
        touch.y = event.clientY
        const distance = Math.max(1, Math.hypot(drag.x - secondTouch.x, drag.y - secondTouch.y))
        const { left, top } = canvas.getBoundingClientRect()
        map.zoom(distance / previousDistance, {
          x: (drag.x + secondTouch.x) / 2 - left,
          y: (drag.y + secondTouch.y) / 2 - top,
        })
        return
      }
      if (drag && drag.id !== event.pointerId) return
      layer?.pointer?.(pointer(event))
      if (!drag) return
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true
      if (event.altKey) {
        const bounds = canvas.getBoundingClientRect()
        const delta = dragRotation({ x: drag.x, y: drag.y }, { x: event.clientX, y: event.clientY },
          { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
        setRotation(map.setRotation((map.view?.rotation ?? 0) + delta))
      } else {
        map.pan(event.clientX - drag.x, event.clientY - drag.y)
      }
      canvas.style.cursor = event.altKey ? 'crosshair' : 'grabbing'
      drag.x = event.clientX
      drag.y = event.clientY
    }
    const end = (event: PointerEvent) => {
      if (drag && secondTouch) {
        if (event.pointerId === drag.id) {
          drag = { ...secondTouch, type: 'touch', startX: secondTouch.x, startY: secondTouch.y, moved: true }
        } else if (event.pointerId !== secondTouch.id) return
        secondTouch = null
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        return
      }
      if (!drag || drag.id !== event.pointerId) return
      const clicked = event.type === 'pointerup' && !drag.moved
      drag = null
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      canvas.style.cursor = 'grab'
      const point = event.type === 'pointerup' ? pointer(event) : null
      layer?.pointer?.(point)
      if (point && clicked) layer?.click?.(point)
    }
    const leave = () => {
      if (!drag) canvas.style.cursor = 'grab'
      layer?.pointer?.(null)
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? map.size.height : 1
      const delta = Math.max(-1000, Math.min(1000, event.deltaY * unit))
      map.zoom(Math.exp(-delta * 0.0015), pointer(event).screen)
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === '+' || event.key === '=') map.zoom(1.4)
      else if (event.key === '-') map.zoom(1 / 1.4)
      else if (event.key === 'Home') map.fit()
      else if (event.key === 'ArrowLeft') map.pan(60, 0)
      else if (event.key === 'ArrowRight') map.pan(-60, 0)
      else if (event.key === 'ArrowUp') map.pan(0, 60)
      else if (event.key === 'ArrowDown') map.pan(0, -60)
      else return
      event.preventDefault()
    }
    const layerKeyDown = (event: KeyboardEvent) => { if (!drag) layer?.keyDown?.(event) }
    resize()
    initialize(map)
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    window.addEventListener('resize', resize)
    window.addEventListener('keydown', layerKeyDown)
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)
    canvas.addEventListener('lostpointercapture', end)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('keydown', keyDown)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', layerKeyDown)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('pointerup', end)
      canvas.removeEventListener('pointercancel', end)
      canvas.removeEventListener('lostpointercapture', end)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('keydown', keyDown)
      if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id)
      if (secondTouch && canvas.hasPointerCapture(secondTouch.id)) canvas.releasePointerCapture(secondTouch.id)
      canvas.style.cursor = 'grab'
      map.dispose()
      mapRef.current = null
    }
  }, [data, mapStyle, attachLayer])

  const controls = <>
    <FormControlLabel label="卫星底图" sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
      control={<Switch size="small" checked={satelliteVisible}
        onChange={(_, checked) => { setSatelliteVisible(checked); setSatelliteError(false) }} />} />
    {satelliteVisible && satelliteError && <Alert severity="warning">部分卫星瓦片加载失败
      <Button size="small" onClick={() => mapRef.current?.retrySatellite()}>重试</Button>
    </Alert>}
    <FormControlLabel label="定位" sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
      control={<Switch size="small" checked={locationEnabled}
        onChange={(_, checked) => { setLocation(null); setLocationEnabled(checked) }} />} />
    {locationEnabled && !location && <LinearProgress aria-label="正在定位" />}
    {locationEnabled && location && 'error' in location && <Alert severity="warning">
      {location.error}
      <Button size="small" onClick={() => { setLocation(null); setLocationAttempt(value => value + 1) }}>重试定位</Button>
    </Alert>}
    <Box>
      <Typography variant="body2">rotation</Typography>
      <Slider size="small" aria-label="rotation" value={rotation} min={-180} max={180}
        step={1} valueLabelDisplay="auto" valueLabelFormat={value => `${Math.round(value)}°`}
        onChange={(_, value) => {
          if (typeof value === 'number') setRotation(mapRef.current?.setRotation(value) ?? value)
        }} />
    </Box>
  </>

  return <Box sx={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
    <canvas ref={canvasRef} tabIndex={0} onContextMenu={onContextMenu}
      aria-label="OSM 地图，可拖动、滚轮缩放、Alt 拖动旋转，也可用方向键和加减键操作"
      style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }} />
    {children ? children(controls) : <Box sx={{
      position: 'absolute', right: 16, top: 16, bgcolor: 'background.paper', width: 180, p: 1.5,
    }}>{controls}</Box>}
    <Box sx={{ position: 'absolute', right: 16, bottom: 8, bgcolor: 'rgba(255,255,255,0.9)', px: 0.5 }}>
      <Typography variant="caption">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
        {satelliteVisible && <> · 影像：<a href={worldImageryService} target="_blank" rel="noreferrer">
          Esri</a>、Vantor、Earthstar Geographics、GIS User Community</>}
      </Typography>
    </Box>
  </Box>
}
