import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import MidiEditor from './pages/MidiEditor'
import EarTrainer from './pages/EarTrainer'
import MobileEarTrainer from './pages/MobileEarTrainer'

function App() {
  const Router = window.__TAURI_INTERNALS__ ? HashRouter : BrowserRouter

  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/midi-editor" element={<MidiEditor />} />
        <Route path="/ear-trainer" element={<EarTrainer />} />
        <Route path="/mobile-ear-trainer" element={<MobileEarTrainer />} />
      </Routes>
    </Router>
  )
}

export default App
