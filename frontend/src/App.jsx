import { Route, Routes } from 'react-router-dom'
import Home from './pages/Home.jsx'
import Room from './pages/Room.jsx'
import Logo from './components/Logo.jsx'
import { config } from './lib/config.js'

// Shown instead of the app when a deployment is missing or has invalid environment variables.
function ConfigError({ errors }) {
  return (
    <div className="bg-glow flex min-h-full flex-col items-center justify-center gap-4 px-5 text-center">
      <Logo />
      <h1 className="text-2xl font-semibold">DropDrop isn’t configured</h1>
      <ul role="alert" className="max-w-xl space-y-1 text-muted">
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      <p className="max-w-xl text-sm text-muted">
        Set <code className="font-mono text-fg">VITE_API_URL</code>, <code className="font-mono text-fg">VITE_WS_URL</code> and{' '}
        <code className="font-mono text-fg">VITE_PUBLIC_APP_URL</code> in your hosting environment, then rebuild.
      </p>
    </div>
  )
}

export default function App() {
  if (config.errors.length) return <ConfigError errors={config.errors} />
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/:roomName" element={<Room />} />
    </Routes>
  )
}
