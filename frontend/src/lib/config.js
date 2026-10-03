// All deployment-specific URLs come from Vite env vars (public values only; never secrets):
//   VITE_API_URL         https://api.example.com        (REST API)
//   VITE_WS_URL          wss://api.example.com          (WebSocket server; "/ws" is appended if missing)
//   VITE_PUBLIC_APP_URL  https://dropdrop.example.com   (used when copying/sharing room links)
// Development falls back to localhost; a production build never silently assumes localhost.

const env = import.meta.env ?? {}
const DEV_DEFAULTS = {
  VITE_API_URL: 'http://localhost:5000',
  VITE_WS_URL: 'ws://localhost:5000',
  VITE_PUBLIC_APP_URL: 'http://localhost:5173',
}

const trimSlash = (s) => s.replace(/\/+$/, '')

export function resolveConfig({ env: e = env, dev = e.DEV, pageProtocol = globalThis.location?.protocol, pageOrigin = globalThis.location?.origin } = {}) {
  const errors = []
  const get = (key) => (e[key] || (dev ? DEV_DEFAULTS[key] : '')).trim()

  const api = get('VITE_API_URL')
  let apiUrl = ''
  if (!api) errors.push('VITE_API_URL is not set. Set it to your backend’s https:// URL and rebuild.')
  else if (!/^https?:\/\/[^\s/]+/i.test(api)) errors.push(`VITE_API_URL "${api}" must start with http:// or https://.`)
  else apiUrl = trimSlash(api)

  let wsUrl = ''
  const ws = get('VITE_WS_URL')
  if (ws) {
    if (!/^wss?:\/\/[^\s/]+/i.test(ws)) errors.push(`VITE_WS_URL "${ws}" must start with ws:// or wss://.`)
    else wsUrl = trimSlash(ws).replace(/\/ws$/, '') + '/ws'
  } else if (apiUrl) {
    wsUrl = apiUrl.replace(/^http/i, 'ws') + '/ws' // https -> wss, http -> ws
  }

  const publicUrl = get('VITE_PUBLIC_APP_URL')
  let publicAppUrl = pageOrigin ? trimSlash(pageOrigin) : ''
  if (publicUrl) {
    if (!/^https?:\/\/[^\s/]+/i.test(publicUrl)) errors.push(`VITE_PUBLIC_APP_URL "${publicUrl}" must start with http:// or https://.`)
    else publicAppUrl = trimSlash(publicUrl)
  }

  let wakeTimeoutMs = 90_000
  const wakeRaw = String(e.VITE_WAKE_TIMEOUT_MS ?? '').trim()
  if (wakeRaw) {
    const n = Number(wakeRaw)
    if (Number.isInteger(n) && n >= 5_000 && n <= 300_000) wakeTimeoutMs = n
    else errors.push('VITE_WAKE_TIMEOUT_MS must be a whole number of milliseconds from 5000 to 300000 (default 90000).')
  }

  if (pageProtocol === 'https:') {
    const local = /^(https?|wss?):\/\/(localhost|127\.0\.0\.1)/i
    if (apiUrl.startsWith('http://') && !local.test(apiUrl)) errors.push('This page is served over HTTPS, so VITE_API_URL must be https:// (browsers block mixed content).')
    if (wsUrl.startsWith('ws://') && !local.test(wsUrl)) errors.push('This page is served over HTTPS, so VITE_WS_URL must be wss://.')
  }
  return { API_URL: apiUrl, WS_URL: wsUrl, PUBLIC_APP_URL: publicAppUrl, WAKE_TIMEOUT_MS: wakeTimeoutMs, errors }
}

export const config = resolveConfig()
