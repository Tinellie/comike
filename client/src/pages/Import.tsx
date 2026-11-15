import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, LinearProgress, Stack, Typography } from '@mui/material'
import RemoteLoginWindow from '../components/RemoteLoginWindow'
import { remoteApi } from '../components/remoteApi'

interface Status {
  status: 'idle' | 'waiting_login' | 'crawling' | 'logging_out' | 'saving' | 'succeeded' | 'failed' | 'cancelled'
  page: number
  pages: number
  imported: number
  savedCount: number
  message: string | null
  login: { open: boolean; authenticated: boolean; width: number; height: number; opening?: boolean; error?: string | null }
}

const labels: Record<Status['status'], string> = {
  idle: '等待导入', waiting_login: '等待 Circle.ms 登录', crawling: '正在读取收藏',
  logging_out: '正在退出 Circle.ms', saving: '正在保存', succeeded: '导入完成', failed: '导入失败', cancelled: '已停止',
}
const activeStatuses: Status['status'][] = ['waiting_login', 'crawling', 'logging_out', 'saving']
const basePath = '/api/import'

export default function Import() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginOpening, setLoginOpening] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const previousLoginOpen = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await remoteApi<Status>(basePath, 'status', undefined, controller.signal)
        if (controller.signal.aborted) return
        if (!result) throw new Error('导入状态为空')
        setStatus(result); setError(null)
        const needsLogin = result.status === 'waiting_login' && (result.login.open || !!result.login.error)
        if (needsLogin && !previousLoginOpen.current) setLoginOpen(true)
        previousLoginOpen.current = needsLogin
        if (result.status !== 'waiting_login') setLoginOpen(false)
        setLoginError(result.login.error ?? null)
      } catch (error) {
        if (controller.signal.aborted) return
        console.error('Import status failed:', error)
        setError(error instanceof Error ? error.message : '导入状态读取失败')
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 1500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [])

  async function action(path: 'start' | 'stop') {
    setBusy(true); setActionError(null)
    try {
      await remoteApi(basePath, path, {})
      const current = await remoteApi<Status>(basePath, 'status')
      if (current) setStatus(current)
    } catch (error) {
      console.error('Import action failed:', error)
      setActionError(error instanceof Error ? error.message : '操作失败')
    } finally { setBusy(false) }
  }
  async function openLogin() {
    setLoginOpen(true); setLoginOpening(true); setLoginError(null)
    try { await remoteApi(basePath, 'login/open', {}) } catch (error) {
      console.error('Import login opening failed:', error)
      setLoginError(error instanceof Error ? error.message : '登录窗口打开失败')
    } finally { setLoginOpening(false) }
  }
  const confirmed = useCallback(() => { setLoginOpen(false); setLoginError(null) }, [])
  const active = status && activeStatuses.includes(status.status)
  return <Box sx={{ maxWidth: 800, mx: 'auto', p: 3 }}>
    <Stack spacing={3}>
      <Typography variant="h4" component="h1">导入 Circle.ms 收藏</Typography>
      <Alert severity="info">
        使用你自己的 Circle.ms 账号登录，读取收藏的标记颜色和备注。全部分页成功后覆盖你的已有收藏，
        已取消收藏的条目会移除；失败或停止时保留旧数据。每次结束自动退出 Circle.ms，不保存第三方登录会话。
      </Alert>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && <Alert severity="error">{actionError}</Alert>}
      {status?.message && <Alert severity={status.status === 'succeeded' ? 'success' : status.status === 'failed' ? 'error' : 'info'}>
        {status.message}
      </Alert>}
      <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
        <Button variant="contained" disabled={busy || !status || !!error || !!active}
          onClick={() => { void action('start') }}>开始导入</Button>
        <Button disabled={loginOpening || status?.status !== 'waiting_login'} onClick={() => { void openLogin() }}>打开登录窗口</Button>
        <Button color="warning" disabled={busy || !status || !['waiting_login', 'crawling'].includes(status.status)}
          onClick={() => { void action('stop') }}>停止</Button>
      </Stack>
      <Typography>已保存 {status?.savedCount ?? '—'} 条收藏</Typography>
      <Typography>{status ? labels[status.status] : '读取状态中…'}</Typography>
      {status && status.pages > 0 && <Typography>第 {status.page} / {status.pages} 页，已读取 {status.imported} 条</Typography>}
      {active && <LinearProgress variant={status?.status === 'crawling' && status.pages ? 'determinate' : 'indeterminate'}
        value={status?.pages ? status.page / status.pages * 100 : 0} aria-label="收藏导入进度" />}
    </Stack>
    {loginOpen && <RemoteLoginWindow basePath={basePath} open opening={loginOpening || !!status?.login.opening}
      openingError={loginError} onRetry={() => { void openLogin() }} onClose={() => setLoginOpen(false)} onConfirmed={confirmed} />}
  </Box>
}
