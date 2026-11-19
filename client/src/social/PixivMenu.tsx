import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, IconButton, LinearProgress, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material'
import { requestSocial } from './api'
import type { PixivJobStatus } from './api'

function RetryWarning({ message, retry }: { message: string; retry: PixivJobStatus['retry'] }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!retry?.retryAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [retry?.retryAt])
  const seconds = retry?.retryAt ? Math.max(0, Math.ceil((retry.retryAt - now) / 1000)) : 0
  return <Alert severity="warning">
    {message}
    {retry && <Typography variant="body2">
      已重试 {retry.attempts} 次；{seconds > 0 ? `${seconds} 秒后进行第 ${retry.attempts + 1} 次重试` : '正在重试…'}
    </Typography>}
  </Alert>
}

export default function PixivMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [jobs, setJobs] = useState<Partial<Record<'twitter' | 'pixiv', PixivJobStatus>>>({})
  const [provider, setProvider] = useState<'twitter' | 'pixiv'>('pixiv')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const action = useRef<AbortController | null>(null)
  useEffect(() => () => action.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const [pixiv, twitter] = await Promise.all([
          requestSocial<PixivJobStatus>('pixiv', '/status', controller.signal),
          requestSocial<PixivJobStatus>('twitter', '/status', controller.signal),
        ])
        if (controller.signal.aborted) return
        setJobs({ pixiv, twitter }); setError(null)
        if (twitter.busy) setProvider('twitter')
        else if (pixiv.busy) setProvider('pixiv')
        if (pixiv.busy || twitter.busy) timer = setTimeout(() => { void poll() }, 1500)
      } catch (reason) {
        if (!controller.signal.aborted) {
          console.error('Social image status failed:', reason)
          setError(reason instanceof Error ? reason.message : '图片任务状态读取失败')
        }
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [revision])

  async function start(target: 'twitter' | 'pixiv', mode: 'refresh' | 'missing') {
    setProvider(target)
    setAnchor(null); setStarting(true); setError(null)
    const controller = new AbortController()
    action.current = controller
    try {
      const result = await requestSocial<PixivJobStatus>(target, '/start', controller.signal, mode)
      if (!controller.signal.aborted) { setJobs(value => ({ ...value, [target]: result })); setRevision(value => value + 1) }
    } catch (reason) {
      if (!controller.signal.aborted) {
        console.error('Social image job start failed:', reason)
        setError(reason instanceof Error ? reason.message : '图片任务启动失败')
      }
    } finally { if (!controller.signal.aborted) setStarting(false) }
  }
  const job = jobs[provider]
  const busy = starting || jobs.pixiv?.busy || jobs.twitter?.busy
  return <Box>
    <Tooltip title="收藏图片"><IconButton aria-label="收藏图片菜单" aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={event => setAnchor(event.currentTarget)}>⋯</IconButton></Tooltip>
    <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
      {(['twitter', 'pixiv'] as const).flatMap(target => [
        <MenuItem key={`${target}-refresh`} disabled={busy || !jobs[target]} onClick={() => { void start(target, 'refresh') }}>刷新 {target} 图片</MenuItem>,
        <MenuItem key={`${target}-missing`} disabled={busy || !jobs[target]} onClick={() => { void start(target, 'missing') }}>补全 {target} 图片</MenuItem>,
      ])}
    </Menu>
    {(error || (job && job.status !== 'idle') || busy) && <Stack role="status" spacing={0.75}
      sx={{ position: 'fixed', bottom: 16, right: 16, zIndex: theme => theme.zIndex.snackbar, maxWidth: 'min(420px, calc(100vw - 32px))', bgcolor: 'background.paper', boxShadow: 3, borderRadius: 1, p: 1.5 }}>
      {error && <Alert severity="error" action={<Button onClick={() => setRevision(value => value + 1)}>重试</Button>}>{error}</Alert>}
      {job?.warning && <RetryWarning key={job.retry?.retryAt ?? 'retrying'} message={job.warning} retry={job.retry} />}
      {busy && <LinearProgress aria-label={`采集 ${provider} 图片`} />}
      {job && job.status !== 'idle' && <Typography variant="body2">
        {provider} {job.status === 'running' ? '采集中' : job.status === 'failed' ? '采集失败' : '采集完成'}：{job.completed}/{job.total} 个账号，更新 {job.updated}，跳过 {job.skipped}，失败 {job.failed}
      </Typography>}
      {job?.message && <Typography variant="body2" color="error">{job.message}</Typography>}
      {job?.status === 'idle' && busy && <Typography variant="body2">已有 {provider} 图片任务正在执行</Typography>}
    </Stack>}
  </Box>
}
