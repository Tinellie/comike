import { useState } from 'react'
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/context'

export default function Login() {
  const { user, loading, login, register } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const destination = params.get('next')
  const next = destination === '/preview' || destination === '/crawler' || destination === '/import' ? destination : '/'
  const [registering, setRegistering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  if (user) return <Navigate to={next} replace />

  async function submit(form: HTMLFormElement) {
    const values = new FormData(form)
    const username = String(values.get('username') ?? '')
    const password = String(values.get('password') ?? '')
    if (registering && password !== values.get('confirmPassword')) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true); setError(null); setMessage(null)
    try {
      if (registering) {
        await register(username, password)
        form.reset()
        setRegistering(false)
        setMessage('注册成功，请使用新账号登录。')
      } else {
        await login(username, password)
        navigate(next, { replace: true })
      }
    } catch (error) {
      console.error('Authentication failed:', error)
      setError(error instanceof Error ? error.message : '操作失败，请重试')
    } finally { setBusy(false) }
  }

  return <Box sx={{ px: 2, py: { xs: 4, sm: 8 } }}>
    <Paper variant="outlined" sx={{ maxWidth: 420, mx: 'auto', p: { xs: 3, sm: 4 } }}>
      <Stack spacing={3}>
        <Box>
          <Typography component="h1" variant="h5" sx={{ fontWeight: 700 }}>{registering ? '注册' : '登录'} Comike</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {registering ? '注册普通账号；管理员权限由服务端授予。' : '使用你的账号登录'}
          </Typography>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
        {message && <Alert severity="success">{message}</Alert>}
        <Stack component="form" spacing={2.5} key={String(registering)}
          onSubmit={event => { event.preventDefault(); void submit(event.currentTarget) }}>
          <TextField name="username" label="账号" autoComplete="username" required fullWidth disabled={busy}
            helperText="3–32 位字母、数字或下划线，不区分大小写"
            slotProps={{ htmlInput: { minLength: 3, maxLength: 32, pattern: '[a-zA-Z0-9_]{3,32}' } }} />
          <TextField name="password" label="密码" type="password" autoComplete={registering ? 'new-password' : 'current-password'}
            required fullWidth disabled={busy} helperText="8–128 位字符"
            slotProps={{ htmlInput: { minLength: 8, maxLength: 128 } }} />
          {registering && <TextField name="confirmPassword" label="确认密码" type="password" autoComplete="new-password"
            required fullWidth disabled={busy} slotProps={{ htmlInput: { minLength: 8, maxLength: 128 } }} />}
          <Button type="submit" variant="contained" size="large" fullWidth disabled={busy || loading}>
            {busy ? '处理中…' : registering ? '注册' : '登录'}
          </Button>
          <Button disabled={busy} onClick={() => {
            setRegistering(value => !value); setError(null); setMessage(null)
          }}>{registering ? '已有账号？去登录' : '没有账号？注册'}</Button>
        </Stack>
      </Stack>
    </Paper>
  </Box>
}
