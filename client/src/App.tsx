import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Map from './pages/Map'
import Preview from './pages/Preview'
import Crawler from './pages/Crawler'
import Login from './pages/Login'
import AdminRoute from './auth/AdminRoute'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="map" element={<Map />} />
        <Route element={<AdminRoute />}>
          <Route path="preview" element={<Preview />} />
          <Route path="crawler" element={<Crawler />} />
        </Route>
        <Route path="login" element={<Login />} />
        <Route path="*" element={null} />
      </Route>
    </Routes>
  )
}
