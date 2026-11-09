import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Map from './pages/Map'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="map" element={<Map />} />
        <Route path="*" element={null} />
      </Route>
    </Routes>
  )
}
