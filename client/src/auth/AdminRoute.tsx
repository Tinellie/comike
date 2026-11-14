import { Alert, Box, Button, LinearProgress } from '@mui/material'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './context'

export default function AdminRoute({ adminOnly = true }: { adminOnly?: boolean }) {
  const { user, loading, error, refresh } = useAuth()
  const location = useLocation()
  if (loading) return <LinearProgress aria-label="检查登录状态" />
  if (error) return <Box sx={{ p: 3 }}><Alert severity="error"
    action={<Button onClick={() => { void refresh() }}>重试</Button>}>{error}</Alert></Box>
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
  if (adminOnly && !user.isAdmin) return <Box sx={{ p: 3 }}><Alert severity="warning">仅管理员可访问此页面。</Alert></Box>
  return <Outlet />
}
