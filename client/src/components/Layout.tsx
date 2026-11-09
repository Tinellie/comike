import { AppBar, Box, Button, Toolbar, Typography } from '@mui/material'
import { NavLink, Outlet } from 'react-router-dom'

export default function Layout() {
  return (
    <Box sx={{ minHeight: '100dvh' }}>
      <AppBar position="static" elevation={0} component="header">
        <Toolbar sx={{ gap: 3 }}>
          <Typography variant="h6" component="span">
            Comike
          </Typography>
          <Box component="nav" aria-label="Main navigation" sx={{ display: 'flex', gap: 1 }}>
            {[
              { to: '/', label: 'Home' },
              { to: '/map', label: 'Map' },
            ].map(({ to, label }) => (
              <Button
                key={to}
                component={NavLink}
                to={to}
                end
                color="inherit"
                sx={{
                  '&.active': { backgroundColor: 'rgba(255, 255, 255, 0.18)' },
                }}
              >
                {label}
              </Button>
            ))}
          </Box>
        </Toolbar>
      </AppBar>
      <Box component="main">
        <Outlet />
      </Box>
    </Box>
  )
}
