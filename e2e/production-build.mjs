// Production-build checks for the website (Vercel-style deployment), against the REAL backend + isolated Atlas DB:
//  1. a build WITH VITE_API_URL / VITE_WS_URL / VITE_PUBLIC_APP_URL works from a deep link, syncs, and shares the public URL;
//  2. a build WITHOUT them shows the configuration page (never silently uses localhost);
//  3. a site served from an origin that is NOT in CLIENT_URL is refused by the server (WebSocket origin check + CORS).
// vercel.json's rewrite itself can only be exercised on Vercel; here `vite preview` provides the same SPA fallback.
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { startBackend, cleanupRooms, sleep } = require(path.join(here, '../vscode-extension/out/test/support/exports.js'))
const frontend = path.join(here, '../frontend')
const vite = path.join(frontend, 'node_modules/vite/bin/vite.js')

let API // set once the backend has started on a free port
const SITE = 'http://localhost:4290' // trusted origin (in CLIENT_URL)
const UNTRUSTED = 'http://localhost:4291' // serves the same build but is NOT in CLIENT_URL
const prefix = `prod-${Date.now().toString(36)}`
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' ' + extra : ''}`) }

const build = (outDir, env) => {
  const clean = { ...process.env }
  for (const k of Object.keys(clean)) if (k.startsWith('VITE_')) delete clean[k]
  execFileSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: frontend, env: { ...clean, ...env }, stdio: 'ignore' })
}
const preview = (outDir, port) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [vite, 'preview', '--outDir', outDir, '--port', String(port), '--strictPort', '--host', 'localhost'], { cwd: frontend, stdio: ['ignore', 'pipe', 'ignore'] })
  const t = setTimeout(() => reject(new Error('preview did not start')), 30000)
  p.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(t); resolve(p) } })
})

const outWith = path.join(here, '.tmp-dist-configured')
const outWithout = path.join(here, '.tmp-dist-unconfigured')
const servers = []
let backend
let browser
try {
  backend = await startBackend({ clientUrl: SITE }) // free port: never collides with a developer's own backend on 5000
  API = backend.apiUrl
  build(outWith, { VITE_API_URL: API, VITE_WS_URL: backend.wsUrl, VITE_PUBLIC_APP_URL: 'https://my-dropdrop.vercel.app', VITE_WAKE_TIMEOUT_MS: '8000' }) // short deadline so check 3 finishes quickly
  build(outWithout, {})
  servers.push(await preview(outWith, 4290), await preview(outWith, 4291), await preview(outWithout, 4292))
  browser = await chromium.launch()
  const text = (p) => p.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => { const c = l.cloneNode(true); c.querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo, .cm-placeholder').forEach((e) => e.remove()); return c.textContent }).join('\n'))

  // 1. configured production build, direct navigation to a room URL (SPA deep link)
  const room = `${prefix}-deep`
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(`${SITE}/${room}`) // deep link, no prior visit to "/"
  await page.waitForSelector('.cm-content')
  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 })
  check('1. deep link /<room> loads the room in a production build and connects over the configured URLs', true)
  await page.click('.cm-content')
  await page.keyboard.type('production build works')
  await page.getByText('✓ Saved').waitFor({ timeout: 15000 })
  await page.reload()
  await page.waitForSelector('.cm-content')
  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 })
  await sleep(500)
  check('1. refresh on the deep link recovers the saved document', (await text(page)) === 'production build works')
  await page.getByRole('button', { name: 'Share room' }).click()
  check('1. Share room copies the configured VITE_PUBLIC_APP_URL (not the page origin, not localhost)', (await page.evaluate(() => navigator.clipboard.readText())) === `https://my-dropdrop.vercel.app/${room}`)
  const indexHtml = await (await fetch(`${SITE}/`)).text()
  const jsPaths = [...indexHtml.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
  const bundle = indexHtml + (await Promise.all(jsPaths.map(async (p) => (await fetch(SITE + p)).text()))).join('')
  check('1. the production bundle was fetched for the secret scan', jsPaths.length > 0 && bundle.length > 100000)
  check('1. no backend secrets / Mongo strings in the served site', !/mongodb(\+srv)?:\/\//i.test(bundle))
  check('1. no console or page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

  // 2. unconfigured production build
  const bare = await (await browser.newContext()).newPage()
  await bare.goto(`${'http://localhost:4292'}/some-room`)
  await bare.getByText('DropDrop isn’t configured').waitFor({ timeout: 10000 })
  check('2. a production build without VITE_API_URL shows the configuration page instead of using localhost', (await bare.getByText(/VITE_API_URL is not set/).count()) > 0)
  check('2. ...and does not try to reach any backend', (await bare.locator('.cm-content').count()) === 0)

  // 3. untrusted origin
  const evil = await (await browser.newContext()).newPage()
  await evil.goto(`${UNTRUSTED}/${room}`)
  await evil.getByRole('alert').getByText(/doesn’t allow connections from this website address/).waitFor({ timeout: 20000 })
  check('3. a website origin missing from CLIENT_URL is refused by the WebSocket origin check (close 4403, permanent, explained)', true)
  check('3. ...and never shows "Connected"', (await evil.getByText('Connected', { exact: true }).count()) === 0)
  await evil.goto(UNTRUSTED + '/')
  await evil.fill('#room', `${prefix}-evil`)
  await evil.click('button[type=submit]')
  // A browser cannot tell a CORS rejection from a sleeping server, so it waits (with the waking message) until the deadline.
  await evil.getByRole('alert').getByText(/didn’t respond within 8 seconds/).waitFor({ timeout: 30000 })
  check('3. ...and REST calls from that origin are blocked by CORS: after the deadline the home page shows a clear error and does not navigate', evil.url() === UNTRUSTED + '/')
  check('3. ...and that error mentions the server may not allow this website address', (await evil.getByRole('alert').innerText()).includes('may not allow this website’s address'))
} finally {
  await browser?.close().catch(() => {})
  servers.forEach((s) => s.kill())
  await backend?.kill().catch(() => {})
  try { console.log(`cleanup (isolated test database): ${cleanupRooms(prefix)}`) } catch { console.log('cleanup failed') }
  rmSync(outWith, { recursive: true, force: true })
  rmSync(outWithout, { recursive: true, force: true })
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} production-build checks passed`)
process.exit(failed ? 1 : 0)
