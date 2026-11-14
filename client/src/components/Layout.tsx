import { useState } from 'react'
import { Alert, AppBar, Box, Button, Toolbar, Typography } from '@mui/material'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/context'

export default function Layout() {
  const { user, loading, error, logout, refresh } = useAuth()
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  async function signOut() {
    setLoggingOut(true); setLogoutError(null)
    try { await logout() } catch (error) {
      console.error('Logout failed:', error)
      setLogoutError(error instanceof Error ? error.message : '退出失败，请重试')
    } finally { setLoggingOut(false) }
  }
  return (
    <Box sx={{ minHeight: '100dvh' }}>
      <AppBar position="static" elevation={0} component="header">
        <Toolbar sx={{ gap: { xs: 1, sm: 3 } }}>
          <Typography variant="h6" component="span" sx={{ flexShrink: 0 }}>
            Comike
          </Typography>
          <Box component="nav" aria-label="Main navigation" sx={{ display: 'flex', gap: 1, minWidth: 0, overflowX: 'auto' }}>
            {[
              { to: '/', label: 'Home' },
              { to: '/map', label: 'Map' },
              ...(user?.isAdmin ? [
                { to: '/preview', label: 'Preview' },
                { to: '/crawler', label: 'Crawler' },
              ] : []),
            ].map(({ to, label }) => (
              <Button
                key={to}
                component={NavLink}
                to={to}
                end
                color="inherit"
                sx={{
                  flexShrink: 0,
                  '&.active': { backgroundColor: 'rgba(255, 255, 255, 0.18)' },
                }}
              >
                {label}
              </Button>
            ))}
          </Box>
          {user ? <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
            <Typography variant="body2">{user.username}{user.isAdmin ? '（管理员）' : ''}</Typography>
            <Button color="inherit" variant="outlined" disabled={loggingOut}
              onClick={() => { void signOut() }}>退出</Button>
          </Box> : <Button component={NavLink} to="/login" color="inherit" variant="outlined" disabled={loading}
            sx={{ ml: 'auto', flexShrink: 0, '&.active': { backgroundColor: 'rgba(255, 255, 255, 0.18)' } }}>
            登录
          </Button>}
        </Toolbar>
      </AppBar>
      {error && <Alert severity="error" action={<Button onClick={() => { void refresh() }}>重试</Button>}>{error}</Alert>}
      {logoutError && <Alert severity="error" onClose={() => setLogoutError(null)}>{logoutError}</Alert>}
      <Box component="main">
        <Outlet />
      </Box>
    </Box>
  )
}
