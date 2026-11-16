import { useEffect, useRef, useState } from 'react'
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  LinearProgress, Stack, TextField,
} from '@mui/material'
import { remoteApi } from './remoteApi'

export default function RemoteLoginWindow({ basePath, open, opening, openingError, onRetry, onClose, onConfirmed }: {
  basePath: string
  open: boolean
  opening: boolean
  openingError: string | null
  onRetry: () => void
  onClose: () => void
  onConfirmed: () => void
}) {
  const [image, setImage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const inputs = useRef(Promise.resolve())

  useEffect(() => {
    if (!open || opening || openingError) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let objectUrl: string | undefined
    async function refresh() {
      try {
        const response = await fetch(`${basePath}/login/screenshot`, {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
        })
        if (response.status === 202) {
          timer = setTimeout(() => { void refresh() }, 1000)
          return
        }
        if (response.status === 409) {
          const result: { message: string; authenticated: boolean } = await response.json()
          if (controller.signal.aborted) return
          if (result.authenticated) onConfirmed()
          else setError(result.message)
          return
        }
        if (!response.ok) throw new Error(`登录画面加载失败（HTTP ${response.status}）`)
        const blob = await response.blob()
        if (controller.signal.aborted) return
        const nextUrl = URL.createObjectURL(blob)
        const previousUrl = objectUrl
        objectUrl = nextUrl
        setImage(nextUrl)
        if (previousUrl) URL.revokeObjectURL(previousUrl)
      } catch (reason) {
        if (controller.signal.aborted) return
        console.error('Remote browser screenshot failed:', reason)
        setError(reason instanceof Error ? reason.message : '登录画面加载失败')
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh() }, 1000)
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [basePath, open, opening, openingError, onConfirmed])

  function input(body: unknown) {
    inputs.current = inputs.current.then(async () => {
      await remoteApi(basePath, 'login/input', body)
    }).catch((reason: unknown) => {
      console.error('Remote browser input failed')
      setError(reason instanceof Error ? reason.message : '远程输入失败')
    })
  }

  async function confirm() {
    setConfirming(true)
    setError(null)
    try {
      await inputs.current
      await remoteApi(basePath, 'login/confirm', {})
      setText('')
      onConfirmed()
    } catch (reason) {
      console.error('Remote login confirmation failed')
      setError(reason instanceof Error ? reason.message : '登录确认失败')
    } finally { setConfirming(false) }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xl" fullWidth>
      <DialogTitle>Web Catalog 远程登录</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity="info">
            这是服务器浏览器的实时画面。点击输入框后可直接键入；
            中文或粘贴内容可使用下方输入栏。完成网站登录后点击“确认登录”。
          </Alert>
          {opening && <Alert severity="info">正在启动服务器浏览器并加载登录页，请稍候…</Alert>}
          {openingError && <Alert severity="error">{openingError}</Alert>}
          {(openingError || error) && <Button onClick={() => { setError(null); onRetry() }}>重试打开登录页</Button>}
          {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
          {image ? (
            <Box component="img" src={image} alt="服务器浏览器登录画面" tabIndex={0} draggable={false}
              sx={{ width: '100%', aspectRatio: '1280 / 800', objectFit: 'contain', display: 'block', border: 1, borderColor: 'divider', outlineOffset: 2 }}
              onClick={event => {
                event.currentTarget.focus()
                const rect = event.currentTarget.getBoundingClientRect()
                input({ type: 'click',
                  x: (event.clientX - rect.left) * event.currentTarget.naturalWidth / rect.width,
                  y: (event.clientY - rect.top) * event.currentTarget.naturalHeight / rect.height })
              }}
              onKeyDown={event => {
                if (event.key === 'Escape') return
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                  event.preventDefault()
                  input({ type: 'text', text: event.key })
                } else if (['Tab', 'Enter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                  event.preventDefault()
                  input({ type: 'key', key: `${event.shiftKey ? 'Shift+' : ''}${event.key}` })
                } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                  event.preventDefault()
                  input({ type: 'key', key: 'Control+a' })
                }
              }} />
          ) : <LinearProgress aria-label="加载登录画面" />}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField fullWidth label="输入到远程浏览器当前焦点（内容隐藏）" type="password"
              autoComplete="new-password" value={text} onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && text) { input({ type: 'text', text }); setText('') }
              }} />
            <Button disabled={!text} onClick={() => { input({ type: 'text', text }); setText('') }}>发送输入</Button>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            {['Tab', 'Enter', 'Backspace', 'Control+a'].map(key => (
              <Button key={key} onClick={() => input({ type: 'key', key })}>{key}</Button>
            ))}
            <Button onClick={() => input({ type: 'wheel', deltaY: -600 })}>向上滚动</Button>
            <Button onClick={() => input({ type: 'wheel', deltaY: 600 })}>向下滚动</Button>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { setText(''); onClose() }}>暂时关闭</Button>
        <Button variant="contained" disabled={confirming || opening || !!openingError} onClick={() => { void confirm() }}>
          {confirming ? '验证中…' : '确认登录'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
