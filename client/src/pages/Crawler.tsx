import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  LinearProgress, Stack, TextField, Typography,
} from '@mui/material'

interface Status {
  id: string | null
  status: string
  action: string
  total: number
  processed: number
  succeeded: number
  failed: number
  listComplete: boolean
  comiket: number | null
  sample: Record<string, unknown> | null
  errors: { id: string; message: string }[]
  listCache: { total: number; completedAt: string; comiket: number | null } | null
  login: { open: boolean; authenticated: boolean; width: number; height: number; opening?: boolean; error?: string | null }
}

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T | undefined> {
  const response = await fetch(`/api/crawler/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(path.endsWith('status') ? 8000 : path === 'reset' ? 120_000 : 45_000)]),
    cache: 'no-store',
  }).catch((reason: unknown) => {
    if (reason instanceof DOMException && reason.name === 'TimeoutError') {
      throw new Error('服务器响应超时，请检查后端是否正在运行或被调试器暂停，然后重试')
    }
    throw reason
  })
  if (!response.ok) {
    const result = await response.json()
    throw new Error(result.message ?? `操作失败（HTTP ${response.status}）`)
  }
  return response.status === 204 ? undefined : response.json()
}

function LoginWindow({ open, opening, openingError, onRetry, onClose, onConfirmed }: {
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
    if (!open) return
    if (opening || openingError) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let objectUrl: string | undefined
    async function refresh() {
      try {
        const state = await api<Status['login']>('login/status', undefined, controller.signal)
        if (controller.signal.aborted) return
        if (!state) throw new Error('登录状态接口返回了空内容')
        if (!state.open && state.authenticated) {
          onConfirmed()
          return
        }
        if (state.error) throw new Error(state.error)
        if (!state.open && !state.opening) {
          setError('服务端登录窗口未打开或服务已重启，请点击“重试打开登录页”')
          return
        }
        if (state.opening) {
          timer = setTimeout(() => { void refresh() }, 1000)
          return
        }
        const response = await fetch('/api/crawler/login/screenshot', {
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
  }, [open, opening, openingError, onConfirmed])

  function input(body: unknown) {
    inputs.current = inputs.current.then(async () => {
      await api('login/input', body)
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
      await api('login/confirm', {})
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
            <Box
              component="img"
              src={image}
              alt="服务器浏览器登录画面"
              tabIndex={0}
              draggable={false}
              sx={{
                width: '100%', aspectRatio: '1280 / 800', objectFit: 'contain',
                display: 'block', border: 1, borderColor: 'divider', outlineOffset: 2,
              }}
              onClick={event => {
                event.currentTarget.focus()
                const rect = event.currentTarget.getBoundingClientRect()
                input({
                  type: 'click',
                  x: (event.clientX - rect.left) * event.currentTarget.naturalWidth / rect.width,
                  y: (event.clientY - rect.top) * event.currentTarget.naturalHeight / rect.height,
                })
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
              }}
            />
          ) : <LinearProgress aria-label="加载登录画面" />}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField
              fullWidth label="输入到远程浏览器当前焦点（内容隐藏）" type="password"
              autoComplete="new-password" value={text}
              onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && text) {
                  input({ type: 'text', text })
                  setText('')
                }
              }}
            />
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

export default function Crawler() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginOpening, setLoginOpening] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetConfirmation, setResetConfirmation] = useState('')
  const previousLoginOpen = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await api<Status>('status', undefined, controller.signal)
        if (!result) throw new Error('状态接口返回了空内容')
        if (controller.signal.aborted) return
        setStatus(result)
        const needsLoginWindow = result.login.open || !!result.login.error
        if (needsLoginWindow && !previousLoginOpen.current) setLoginOpen(true)
        previousLoginOpen.current = needsLoginWindow
        if (result.login.error) setLoginError(result.login.error)
        setStatusError(null)
      } catch (reason) {
        if (controller.signal.aborted) return
        console.error('Crawler status failed:', reason)
        setStatusError(reason instanceof Error ? reason.message : '采集状态加载失败')
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 1500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [])

  async function action(path: string, body: unknown = {}) {
    setBusy(true)
    setNotice(null)
    setError(null)
    try {
      const result = await api<{ message?: string }>(path, body)
      if (result?.message) setNotice(result.message)
      if (path === 'reset') {
        setResetOpen(false)
        setResetConfirmation('')
        const current = await api<Status>('status')
        if (current) setStatus(current)
      }
      if (path === 'login/open') setLoginOpen(true)
    } catch (reason) {
      console.error('Crawler action failed:', reason)
      setError(reason instanceof Error ? reason.message : '操作失败')
    } finally { setBusy(false) }
  }

  async function openLogin() {
    setLoginOpen(true)
    setLoginOpening(true)
    setLoginError(null)
    try {
      await api('login/open', {})
    } catch (reason) {
      console.error('Remote login opening failed:', reason)
      setLoginError(reason instanceof Error ? reason.message : '登录窗口打开失败')
    } finally { setLoginOpening(false) }
  }

  const loginConfirmed = useCallback(() => {
    setLoginOpen(false)
    setLoginError(null)
    setNotice('网站登录成功，等待中的任务会自动继续')
  }, [])

  const active = ['listing', 'details', 'waiting_login', 'stopping', 'resetting'].includes(status?.status ?? '')
  const progress = status?.total ? Math.min(100, status.processed / status.total * 100) : 0

  return (
    <Box sx={{ maxWidth: 1050, mx: 'auto', p: 3 }}>
      <Stack spacing={3}>
        <Typography variant="h4">爬虫 Dashboard</Typography>
        <Alert severity="warning">
          当前未实现管理鉴权。任何能访问本页面和 API 的人都能控制爬虫及登录会话；
          使用真实账号前请通过防火墙、VPN 或反向代理限制访问，不要直接公开。
        </Alert>
        {error && <Alert severity="error">{error}</Alert>}
        {statusError && <Alert severity="error">{statusError}</Alert>}
        {notice && <Alert severity="success">{notice}</Alert>}
        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Button disabled={busy || active} onClick={() => { void action('initialize') }}>初始化数据库</Button>
          <Button variant="contained" disabled={busy || active} onClick={() => { void action('start') }}>开始采集</Button>
          <Button disabled={busy || active || !status?.id} onClick={() => { void action('start', { resume: true }) }}>继续 / 重试失败项</Button>
          <Button disabled={busy || active} onClick={() => { void action('start', { refreshList: true }) }}>刷新列表并采集</Button>
          <Button color="warning" disabled={busy || !active || ['stopping', 'resetting'].includes(status?.status ?? '')} onClick={() => { void action('stop') }}>停止</Button>
          <Button disabled={loginOpening} onClick={() => { void openLogin() }}>打开登录窗口</Button>
          <Button disabled={busy || active} onClick={() => { void action('login/clear') }}>清除登录会话</Button>
          <Button color="error" disabled={busy || active || !status || !!statusError} onClick={() => { setResetConfirmation(''); setResetOpen(true) }}>清空数据和图片</Button>
        </Stack>
        <Typography>
          网站会话：{status?.login.authenticated ? '已登录' : '未确认登录'}
          {status?.comiket ? ` · Comiket C${status.comiket}` : ''}
        </Typography>
        {status?.listCache && <Alert severity="info">
          完整列表缓存：{status.listCache.total} 个社团
          {status.listCache.comiket ? ` · C${status.listCache.comiket}` : ''}
          {` · ${new Date(status.listCache.completedAt).toLocaleString()}`}。
          开始或继续采集会复用缓存，并按数据库跳过已保存详情；换届或名单更新时请选择“刷新列表并采集”。
        </Alert>}
        <Box aria-live="polite">
          <Typography sx={{ mb: 1 }}>{status?.action ?? '等待连接服务器'}</Typography>
          <LinearProgress
            variant={status?.listComplete ? 'determinate' : active ? 'indeterminate' : 'determinate'}
            value={progress}
            aria-label="采集进度"
          />
          <Typography sx={{ mt: 1 }}>
            {status?.listComplete
              ? `${status.succeeded}/${status.total} 个已读取社团 · 失败 ${status.failed} 个 · 已处理 ${status.processed}/${status.total}`
              : `爬取列表阶段 · 已发现 ${status?.total ?? 0} 个社团`}
          </Typography>
        </Box>
        {!!status?.errors.length && (
          <Alert severity="error">
            {status.errors.map(item => <Typography key={item.id}>{item.id}：{item.message}</Typography>)}
          </Alert>
        )}
        <Typography variant="h6">一条已保存的示例数据</Typography>
        {status?.sample ? (
          <Box component="pre" sx={{ m: 0, p: 2, bgcolor: 'action.hover', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(status.sample, null, 2)}
          </Box>
        ) : <Typography color="text.secondary">首条详情和图片保存成功后显示。</Typography>}
      </Stack>
      <Dialog open={resetOpen} onClose={() => { if (!busy) setResetOpen(false) }} maxWidth="sm" fullWidth>
        <DialogTitle>清空 booth 数据和图片</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="warning">
              此操作不可撤销：删除全部 booth 数据、地图未匹配位置、采集任务记录和 storage 中 booths 目录下的爬虫图片。
              保留数据库表结构、完整 ID 列表缓存、登录会话及其他资源，不会自动重新采集。
            </Alert>
            <TextField
              autoFocus fullWidth label="输入“清空”以确认" value={resetConfirmation} disabled={busy}
              onChange={event => setResetConfirmation(event.target.value)}
            />
            {error && <Alert severity="error">{error}</Alert>}
            {busy && <LinearProgress aria-label="清空数据中" />}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setResetOpen(false)}>取消</Button>
          <Button color="error" variant="contained" disabled={busy || active || resetConfirmation !== '清空'}
            onClick={() => { void action('reset', { confirmation: resetConfirmation }) }}>
            {busy ? '正在清空…' : '确认清空'}
          </Button>
        </DialogActions>
      </Dialog>
      {loginOpen && <LoginWindow
        open opening={loginOpening || !!status?.login.opening} openingError={loginError}
        onRetry={() => { void openLogin() }}
        onClose={() => setLoginOpen(false)} onConfirmed={loginConfirmed} />}
    </Box>
  )
}
