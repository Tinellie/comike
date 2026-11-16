import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import AuthProvider from './auth/AuthProvider'

const theme = createTheme({
  typography: {
    fontFamily: '"BIZ UDPGothic", "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif',
  },
  palette: {
    primary: { main: '#1976d2' },
    background: { default: '#ffffff' },
  },
})

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element is missing')
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider><App /></AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
