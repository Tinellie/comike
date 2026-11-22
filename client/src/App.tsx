import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Map from './pages/Map'
import Map2 from './pages/Map2'
import Preview from './pages/Preview'
import Crawler from './pages/Crawler'
import Login from './pages/Login'
import AdminRoute from './auth/AdminRoute'
import Import from './pages/Import'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="map" element={<Map />} />
        <Route path="map2" element={<Map2 />} />
        <Route element={<AdminRoute adminOnly={false} />}>
          <Route path="import" element={<Import />} />
        </Route>
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
