// Shared infrastructure for the cross-platform tests. Nothing here mocks synchronisation:
//  * the backend is the real backend/src/server.js using the isolated Atlas database "dropdrop_test";
//  * the website is the real Vite app in headless Chromium;
//  * each "VS Code instance" = the extension's real CollaborationService + real WebviewRelay (extension host side)
//    + the real webview bundle (dist/webview.js) in its own Chromium page, with only acquireVsCodeApi()
//    supplied by the test and bridged straight to the relay.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
export const ext = require(path.join(here, '../vscode-extension/out/test/support/exports.js'))
const { CollaborationService, WebviewRelay, requireEndpoints, startBackend, cleanupRooms, sleep } = ext
export { sleep, startBackend }

// The API port is chosen at runtime (a free port), never a fixed one: a developer's own backend usually owns 5000.
export const WEB_PORT = 5183 // own port: never collides with other local dev servers
export const WEB = `http://localhost:${WEB_PORT}`

// Options: { gateway: {mode, wakeAfterMs} } routes the website through a sleepy gateway (a sleeping free-tier host);
//          { wakeTimeoutMs } shortens the website's ~90 s wake deadline so its timeout path can be tested.
export async function createHarness({ gateway: gatewayOptions = null, wakeTimeoutMs = null } = {}) {
  const prefix = `xp-${Date.now().toString(36)}`
  let n = 0
  const results = []
  const pageErrors = []
  const consoleErrors = []

  const check = (name, ok, extra = '') => {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' ' + extra : ''}`)
  }
  const until = async (fn, label, timeout = 20000) => {
    const t = Date.now()
    while (Date.now() - t < timeout) {
      try { if (await fn()) return true } catch { /* page navigating */ }
      await sleep(40)
    }
    check(label, false, '(timed out)')
    return false
  }

  const h = { prefix, results, pageErrors, consoleErrors, check, until, sleep, backend: null }
  h.room = () => `${prefix}-${++n}`
  h.backend = await startBackend({ clientUrl: WEB })
  const API_PORT = h.backend.port
  h.apiPort = API_PORT
  h.restartBackend = async () => { h.backend = await startBackend({ port: API_PORT, clientUrl: WEB }) } // same port: clients reconnect to it

  h.gateway = gatewayOptions ? await ext.startSleepyGateway({ targetPort: h.backend.port, ...gatewayOptions }) : null
  const apiHttp = h.gateway ? h.gateway.url : `http://127.0.0.1:${API_PORT}`
  const apiWs = h.gateway ? h.gateway.wsUrl : `ws://127.0.0.1:${API_PORT}`

  const vite = spawn(process.execPath, [path.join(here, '../frontend/node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort', '--host', 'localhost'], {
    cwd: path.join(here, '../frontend'),
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, VITE_API_URL: apiHttp, VITE_WS_URL: apiWs, VITE_PUBLIC_APP_URL: WEB, ...(wakeTimeoutMs ? { VITE_WAKE_TIMEOUT_MS: String(wakeTimeoutMs) } : {}) },
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start')), 60000)
    vite.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(timer); resolve() } })
    vite.once('exit', () => reject(new Error('vite exited early')))
  })
  const browser = await chromium.launch()
  h.browser = browser

  const track = (page, label) => {
    page.on('pageerror', (e) => pageErrors.push(`${label}: ${e}`))
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`) })
  }
  const endpoints = () => requireEndpoints({ apiUrl: `http://127.0.0.1:${API_PORT}`, websocketUrl: `ws://127.0.0.1:${API_PORT}`, publicAppUrl: WEB })

  // Document text without remote-cursor name labels (they live inside .cm-content and differ per viewer).
  h.docText = (p) => p.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => {
    const c = l.cloneNode(true)
    c.querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo, .cm-placeholder').forEach((e) => e.remove())
    return c.textContent.replace(/[​⁠]/g, '')
  }).join('\n'))

  h.newPage = async (label) => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await ctx.newPage()
    track(page, label)
    return page
  }

  h.openWebsite = async (roomName, label) => {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await ctx.newPage()
    track(page, label)
    await page.goto(`${WEB}/${roomName}`)
    await page.waitForSelector('.cm-content')
    await page.getByText('Connected', { exact: true }).waitFor({ timeout: 15000 })
    return page
  }

  /** One simulated VS Code window for a room. */
  h.openVsCode = async (roomName, label) => {
    const service = new CollaborationService(endpoints, { maxBackoffTime: 300 })
    const { session } = await service.join(roomName)
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    track(page, label)
    const copied = []
    const relay = new WebviewRelay(
      session,
      (msg) => void page.evaluate((m) => window.postMessage(m, '*'), msg).catch(() => {}),
      { copyText: (t) => copied.push(t), copyLink: () => copied.push('LINK'), reconnect() {}, leave: () => service.leave() },
      () => `${WEB}/${roomName}`,
    )
    await page.exposeFunction('__toHost', (json) => relay.handle(JSON.parse(json)))
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(JSON.stringify(m)) })
    })
    await page.goto(pathToFileURL(path.join(here, 'webview-harness.html')).href)
    await page.waitForSelector('.cm-content')
    await page.getByText('Connected', { exact: true }).first().waitFor({ timeout: 15000 })
    return {
      service, session, page, copied, label,
      text: () => h.docText(page),
      type: async (s, delay = 0) => { await page.click('.cm-content'); await page.keyboard.type(s, { delay }) },
      close: async () => { service.dispose(); relay.dispose(); await ctx.close() },
    }
  }

  h.same = async (...getters) => { const t = await Promise.all(getters.map((g) => g())); return t.every((x) => x === t[0]) }

  h.teardown = async () => {
    await browser.close().catch(() => {})
    vite.kill()
    await h.gateway?.stop().catch(() => {})
    await h.backend.kill().catch(() => {})
    try { console.log(`cleanup (isolated test database): ${cleanupRooms(prefix)}`) } catch { console.log('cleanup failed') }
  }
  return h
}
