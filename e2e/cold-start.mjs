// Cold-start tests in a real browser: the real website + the real backend + a gateway that behaves like a sleeping
// free-tier host (answers 503 with no CORS headers until it "wakes"). Verifies the wake message, cancel, double
// submit, deep links, the timeout path, and that retries never create duplicate rooms.
// Prerequisite (in vscode-extension): npm run build && node esbuild.mjs --tests
import { createHarness } from './lib.mjs'

const WAKE_MESSAGE = 'Waking the DropDrop server. This may take up to a minute.'
// The gateway starts ASLEEP and only wakes when a test says so (no timers started before the browser is ready).
const h = await createHarness({ gateway: { mode: '503' }, wakeTimeoutMs: 12000 })
const { check, room, sleep } = h
const g = h.gateway
const posts = () => g.forwarded.filter((f) => f.method === 'POST' && f.path === '/api/rooms').length
const visible = (page, text, timeout) => page.getByText(text).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false)
const hidden = (page, text, timeout) => page.getByText(text).first().waitFor({ state: 'hidden', timeout }).then(() => true, () => false)
const backendHas = async (name) => (await fetch(`${h.backend.apiUrl}/api/rooms/${name}`)).status === 200

try {
  // ---- 1. Home page: the server is asleep for ~6 s ----
  const r1 = room()
  const page = await h.newPage('home')
  await page.goto(WEBURL())
  await page.fill('#room', r1)
  const t0 = Date.now()
  setTimeout(() => g.wakeNow(), 6000) // the server wakes 6 s after the click
  await page.click('button[type=submit]')
  check('1. a waking message appears while the server sleeps', await visible(page, WAKE_MESSAGE, 6000))
  check('1. the submit button is disabled while waiting (no double requests)', await page.locator('button[type=submit]').isDisabled())
  await page.waitForURL(`**/${r1}`, { timeout: 40000 })
  const waited = Date.now() - t0
  check(`1. after the server wakes the room opens by itself (waited ${waited} ms)`, waited >= 5000 && waited < 20000)
  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 })
  check('1. the room connects over the woken server', true)
  check('1. exactly ONE create-room request reached the backend (retries only used the read-only health check)', posts() === 1, `(posts=${posts()})`)
  check('1. the room exists on the backend', await backendHas(r1))

  // ---- 2. Cancel ----
  g.sleepAgain()
  const before = g.forwarded.length
  const r2 = room()
  const home2 = await h.newPage('home2')
  await home2.goto(WEBURL())
  await home2.fill('#room', r2)
  await home2.click('button[type=submit]')
  check('2. waking message shown again after the server went back to sleep', await visible(home2, WAKE_MESSAGE, 6000))
  await home2.getByRole('button', { name: 'Cancel' }).click()
  check('2. Cancel removes the waking message', await hidden(home2, WAKE_MESSAGE, 3000))
  check('2. Cancel stays on the home page with the button usable again', home2.url().replace(/\/$/, '') === WEBURL().replace(/\/$/, '') && !(await home2.locator('button[type=submit]').isDisabled()))
  check('2. Cancel shows no error', (await home2.getByRole('alert').count()) === 0)
  await sleep(2500)
  check('2. nothing was sent to the backend after cancelling (no room created)', g.forwarded.length === before && !(await backendHas(r2)))

  // ---- 3. Double submit while waiting ----
  const r3 = room()
  const home3 = await h.newPage('home3')
  await home3.goto(WEBURL())
  await home3.fill('#room', r3)
  const postsBefore = posts()
  setTimeout(() => g.wakeNow(), 4000)
  await home3.press('#room', 'Enter')
  await home3.press('#room', 'Enter')
  await home3.press('#room', 'Enter')
  await home3.waitForURL(`**/${r3}`, { timeout: 30000 })
  check('3. pressing Enter three times creates exactly one room request', posts() - postsBefore === 1, `(new posts=${posts() - postsBefore})`)

  // ---- 4. Direct link to a room while the server sleeps ----
  g.sleepAgain()
  const r4 = room()
  const deep = await h.newPage('deep')
  await deep.goto(`${WEBURL()}/${r4}`)
  check('4. a room opened by direct link shows the waking message', await visible(deep, WAKE_MESSAGE, 12000))
  check('4. ...and not the "connection lost" message (it never connected yet)', (await deep.getByText(/Your edits are kept in this tab/).count()) === 0)
  g.wakeNow()
  await deep.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 })
  check('4. it connects by itself once the server is up', true)
  check('4. the waking message disappears', await hidden(deep, WAKE_MESSAGE, 5000))
  await deep.click('.cm-content')
  await deep.keyboard.type('typed after a cold start')
  await deep.getByText('✓ Saved').waitFor({ timeout: 15000 })
  check('4. editing and saving work right after a cold start', true)

  // ---- 5. Deadline (12 s in this test; 90 s in production) ----
  g.sleepAgain()
  const r5 = room()
  const home5 = await h.newPage('home5')
  await home5.goto(WEBURL())
  await home5.fill('#room', r5)
  const p5 = posts()
  await home5.click('button[type=submit]')
  const gaveUp = await home5.getByRole('alert').getByText(/didn’t respond within 12 seconds/).waitFor({ timeout: 25000 }).then(() => true, () => false)
  check('5. after the deadline a clear error is shown', gaveUp)
  check('5. ...with no room created and the form usable again', posts() === p5 && !(await home5.locator('button[type=submit]').isDisabled()))
  g.wakeNow()
  await home5.click('button[type=submit]') // "try again"
  await home5.waitForURL(`**/${r5}`, { timeout: 20000 })
  check('5. trying again after the server is up works, and creates exactly one room', posts() - p5 === 1)

  // ---- 6. Room page deadline + "Try again" ----
  g.sleepAgain()
  const r6 = room()
  const deep6 = await h.newPage('deep6')
  await deep6.goto(`${WEBURL()}/${r6}`)
  const fail6 = await deep6.getByRole('alert').getByText(/server didn’t respond/).waitFor({ timeout: 25000 }).then(() => true, () => false)
  check('6. a room that never connects shows a clear failure with "Try again" after the deadline', fail6)
  g.wakeNow()
  await deep6.getByRole('button', { name: 'Try again' }).click()
  await deep6.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 })
  check('6. "Try again" connects once the server is awake', true)

  check('no uncaught page errors', h.pageErrors.length === 0, h.pageErrors.slice(0, 2).join(' | '))
} finally {
  await h.teardown()
}

function WEBURL() {
  return 'http://localhost:5183'
}

const failed = h.results.filter((r) => !r.ok)
console.log(`\n${h.results.length - failed.length}/${h.results.length} cold-start checks passed`)
process.exit(failed.length ? 1 : 0)
