import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  LinearProgress, Stack, TextField, Typography,
} from '@mui/material'
import LoginWindow from '../components/RemoteLoginWindow'
import { remoteApi } from '../components/remoteApi'

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

interface OrganizationStatus {
  event: { eventId: string; comiket: number } | null
  vacancies: number
  vacancyReady: boolean
  genreReady: boolean
  organizing: boolean
}

function api<T>(path: string, body?: unknown, signal?: AbortSignal) {
  return remoteApi<T>('/api/crawler', path, body, signal)
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
  const [organization, setOrganization] = useState<OrganizationStatus | null>(null)
  const [organizationError, setOrganizationError] = useState<string | null>(null)
  const previousLoginOpen = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const organizationRequest = api<OrganizationStatus>('organization', undefined, controller.signal).then(result => {
        if (controller.signal.aborted) return
        if (!result) throw new Error('地图整理状态为空')
        setOrganization(result); setOrganizationError(null)
      }).catch((reason: unknown) => {
        if (controller.signal.aborted) return
        console.error('Map organization status failed:', reason)
        setOrganizationError(reason instanceof Error ? reason.message : '地图整理状态读取失败')
      })
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
      await organizationRequest
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
      if (path === 'organize' || path === 'reset') {
        const current = await api<OrganizationStatus>('organization')
        if (current) { setOrganization(current); setOrganizationError(null) }
      }
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

  const active = !!organization?.organizing || ['listing', 'details', 'waiting_login', 'stopping', 'resetting'].includes(status?.status ?? '')
  const progress = status?.total ? Math.min(100, status.processed / status.total * 100) : 0

  return (
    <Box sx={{ maxWidth: 1050, mx: 'auto', p: 3 }}>
      <Stack spacing={3}>
        <Typography variant="h4">爬虫 Dashboard</Typography>
        <Alert severity="warning">
          本页面仅供管理员使用，管理员共享此采集会话。个人 Circle.ms 收藏请使用“Import”页面，
          不要在此页面登录个人收藏账号。
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
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>地图数据整理</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {organization?.event ? `C${organization.event.comiket} · vacancies ${organization.vacancies} 个半格` : '暂无可整理活动'}
          </Typography>
          {organizationError && <Alert severity="error" sx={{ mb: 1 }}>{organizationError}</Alert>}
          <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
            <Button variant={organization && !organization.vacancyReady ? 'contained' : 'outlined'}
              disabled={busy || active || !organization?.event || !!organizationError}
              onClick={() => { void action('organize', { kind: 'vacancies' }) }}>整理 vacancies 数据</Button>
            <Button variant={organization && !organization.genreReady ? 'contained' : 'outlined'}
              disabled={busy || active || !organization?.event || !!organizationError}
              onClick={() => { void action('organize', { kind: 'genres' }) }}>整理 genre 数据</Button>
          </Stack>
          {organization?.organizing && <LinearProgress aria-label="整理地图数据" sx={{ mt: 1 }} />}
        </Box>
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
        basePath="/api/crawler" open opening={loginOpening || !!status?.login.opening} openingError={loginError}
        onRetry={() => { void openLogin() }}
        onClose={() => setLoginOpen(false)} onConfirmed={loginConfirmed} />}
    </Box>
  )
}
