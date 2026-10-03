#!/usr/bin/env node
// Verifies a DEPLOYED DropDrop backend from the outside.
//
//   node scripts/verify-deployment.mjs --api https://api.example.com --origin https://your-site.vercel.app
//   node scripts/verify-deployment.mjs --api ... --origin ... --write-test     (also opens one real room, see below)
//
// By default every check is READ-ONLY: nothing is written to the database. The WebSocket checks use requests that
// the server rejects before it ever touches a room (wrong Origin, invalid room name).
// --write-test additionally connects to ONE room named "deploy-check-<timestamp>" with the allowed Origin, which
// creates that (empty) room in the database. There is no delete endpoint; remove it in Atlas if you want it gone.
import WebSocket from 'ws'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const api = (opt('api') || '').replace(/\/+$/, '')
const origin = (opt('origin') || '').replace(/\/+$/, '')
const writeTest = args.includes('--write-test')
if (!/^https?:\/\//.test(api) || !/^https?:\/\//.test(origin)) {
  console.error('Usage: node scripts/verify-deployment.mjs --api <https://api-host> --origin <https://website-origin> [--write-test]')
  process.exit(2)
}
const wsBase = api.replace(/^http/, 'ws') + '/ws'
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(api)

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}
const note = (text) => console.log(`NOTE  ${text}`)
const get = async (path, headers = {}) => {
  try {
    return await fetch(api + path, { headers, signal: AbortSignal.timeout(20000) })
  } catch (e) {
    return { ok: false, status: 0, headers: new Headers(), json: async () => ({}), error: e }
  }
}
/** Opens a WebSocket and resolves with the close code (or 'open' if it stayed open for 1.5 s). */
const wsOutcome = (url, headers) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 20000 })
    let firstBinary = null
    const timer = setTimeout(() => { resolve({ result: 'open', firstBinary }); ws.close() }, 1500)
    ws.on('message', (d, isBinary) => { if (isBinary && firstBinary === null) firstBinary = d[0] })
    ws.on('close', (code) => { clearTimeout(timer); resolve({ result: code, firstBinary }) })
    ws.on('error', () => {})
  })

console.log(`Checking ${api} for website origin ${origin}\n`)

// 1. transport
check('API uses HTTPS (required for a public deployment)', api.startsWith('https://') || isLocal, api.startsWith('http://') && !isLocal ? 'plain http to a non-local host' : '')

// 2. health
const health = await get('/api/health')
const hBody = health.ok ? await health.json() : {}
check('GET /api/health is 200 with database connected', health.status === 200 && hBody.database === 'connected', `(status ${health.status})`)
check('security headers present (helmet)', Boolean(health.headers.get('x-content-type-options')) && !health.headers.get('x-powered-by'))

// 3. proxy hop count
const ci = await get('/api/client-ip')
const ciBody = ci.ok ? await ci.json() : {}
check('GET /api/client-ip answers', ci.status === 200, ci.status === 200 ? `-> your address as the server sees it: ${ciBody.ip}; trusted proxy hops: ${ciBody.trustedProxyHops}` : `(status ${ci.status})`)
note('Compare that address with your real public IP (e.g. open https://api.ipify.org). If it is a proxy/edge address, TRUST_PROXY is one too low; if it differs in a way you could forge, it is too high.')

// 4. CORS
const allowed = await get('/api/health', { Origin: origin })
check('CORS: the website origin is allowed', allowed.headers.get('access-control-allow-origin') === origin, `(got "${allowed.headers.get('access-control-allow-origin')}")`)
const evil = await get('/api/health', { Origin: 'https://evil.example' })
check('CORS: an untrusted origin is NOT allowed', evil.headers.get('access-control-allow-origin') === null)
const wildcard = allowed.headers.get('access-control-allow-origin') === '*'
check('CORS: no wildcard', !wildcard)

// 5. WebSocket enforcement (read-only: both are rejected before any room is loaded)
const bad = await wsOutcome(`${wsBase}/verify-origin-check`, { Origin: 'https://evil.example' })
check('WebSocket: an untrusted Origin is closed with 4403', bad.result === 4403, `(got ${bad.result})`)
const invalid = await wsOutcome(`${wsBase}/bad%20room%20name`, { Origin: origin })
check('WebSocket: an invalid room name is closed with 4400', invalid.result === 4400, `(got ${invalid.result})`)

// 6. optional real-room handshake
if (writeTest) {
  const room = `deploy-check-${Date.now().toString(36)}`
  const real = await wsOutcome(`${wsBase}/${room}`, { Origin: origin })
  check(`WebSocket: the allowed Origin can open a room (creates "${room}")`, real.result === 'open' && real.firstBinary === 0, `(got ${real.result}, first message type ${real.firstBinary})`)
} else {
  note('Skipped the real-room WebSocket handshake (it would create a room). Re-run with --write-test to include it.')
}

console.log(`\n${failed ? `${failed} check(s) FAILED` : 'All checks passed'}`)
process.exit(failed ? 1 : 0)
