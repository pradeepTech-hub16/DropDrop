import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WAKE_MESSAGE, WakeTimeoutError, waitForServer } from '../src/lib/wake.js'
import { resolveConfig } from '../src/lib/config.js'

const FAST = { apiUrl: 'https://api.test', retryDelayMs: 10, wakingAfterMs: 30, attemptTimeoutMs: 200 }
const ok = () => new Response(JSON.stringify({ status: 'ok', database: 'connected' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const status = (code, body = '{}') => new Response(body, { status: code })

/** A fetch that plays a script of outcomes and records how many requests were in flight at once. */
function scripted(steps) {
  const calls = { n: 0, inflight: 0, maxInflight: 0, urls: [] }
  const fetchImpl = async (url, init) => {
    calls.urls.push(String(url))
    const step = steps[Math.min(calls.n++, steps.length - 1)]
    calls.inflight++
    calls.maxInflight = Math.max(calls.maxInflight, calls.inflight)
    try {
      if (step === 'network') throw new TypeError('Failed to fetch')
      if (step === 'hang') {
        await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }
      return typeof step === 'function' ? step() : step
    } finally {
      calls.inflight--
    }
  }
  return { fetchImpl, calls }
}

describe('waitForServer (cold-start handling)', () => {
  it('an awake server answers on the first try: no waiting, no "waking" message', async () => {
    const { fetchImpl, calls } = scripted([ok])
    let woke = 0
    const res = await waitForServer({ ...FAST, fetchImpl, onWaking: () => woke++ })
    assert.deepEqual(res, { waited: false })
    assert.equal(calls.n, 1)
    assert.equal(woke, 0)
    assert.deepEqual(calls.urls, ['https://api.test/api/health'])
  })

  it('a sleeping server (network errors, then 503, then ok): waits, announces once, ends as soon as it is up', async () => {
    const { fetchImpl, calls } = scripted(['network', 'network', () => status(503), ok])
    let woke = 0
    const res = await waitForServer({ ...FAST, fetchImpl, onWaking: () => woke++ })
    assert.deepEqual(res, { waited: true })
    assert.equal(calls.n, 4)
    assert.equal(woke, 1, 'the message is shown once, not once per retry')
  })

  it('never has two requests in flight (retries are sequential, so nothing can be duplicated)', async () => {
    const { fetchImpl, calls } = scripted(['network', 'network', 'network', ok])
    await waitForServer({ ...FAST, fetchImpl })
    assert.equal(calls.maxInflight, 1)
  })

  it('only ever asks the read-only health endpoint (never creates anything while waiting)', async () => {
    const { fetchImpl, calls } = scripted(['network', status(502), ok])
    await waitForServer({ ...FAST, fetchImpl })
    assert.ok(calls.urls.every((u) => u === 'https://api.test/api/health'))
  })

  it('treats 502/503/504, 408 and 429 as "not ready yet"', async () => {
    const { fetchImpl, calls } = scripted([() => status(502), () => status(503), () => status(504), () => status(408), () => status(429), ok])
    await waitForServer({ ...FAST, fetchImpl })
    assert.equal(calls.n, 6)
  })

  it('a hosting "waking up" page that answers 200 but is not the health payload keeps waiting', async () => {
    const { fetchImpl, calls } = scripted([() => status(200, '<html>Service waking up</html>'), ok])
    await waitForServer({ ...FAST, fetchImpl })
    assert.equal(calls.n, 2)
  })

  it('a single attempt that hangs is cut off by the per-attempt timeout and retried', async () => {
    const { fetchImpl, calls } = scripted(['hang', ok])
    const t0 = Date.now()
    await waitForServer({ ...FAST, attemptTimeoutMs: 80, fetchImpl })
    assert.equal(calls.n, 2)
    assert.ok(Date.now() - t0 >= 70)
  })

  it('shows the waking message while a slow first attempt is still pending (before it fails)', async () => {
    let woke = false
    const { fetchImpl } = scripted([
      async () => {
        await new Promise((r) => setTimeout(r, 120))
        return ok()
      },
    ])
    await waitForServer({ ...FAST, wakingAfterMs: 30, attemptTimeoutMs: 1000, fetchImpl, onWaking: () => (woke = true) })
    assert.equal(woke, true)
  })

  it('gives up at the deadline with a clear error', async () => {
    const { fetchImpl } = scripted([() => status(503)])
    const t0 = Date.now()
    await assert.rejects(waitForServer({ ...FAST, timeoutMs: 250, fetchImpl }), (e) => e instanceof WakeTimeoutError && e.code === 'SERVER_WAKE_TIMEOUT' && /try again/i.test(e.message))
    assert.ok(Date.now() - t0 < 1500)
  })

  it('cancelling stops immediately: rejects with AbortError and makes no further requests', async () => {
    const { fetchImpl, calls } = scripted(['network'])
    const ac = new AbortController()
    const pending = waitForServer({ ...FAST, retryDelayMs: 50, fetchImpl, signal: ac.signal })
    await new Promise((r) => setTimeout(r, 120))
    ac.abort()
    const seen = calls.n
    await assert.rejects(pending, (e) => e.name === 'AbortError')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(calls.n, seen, 'no request is made after cancelling')
  })

  it('cancelling while an attempt is in flight also aborts that request', async () => {
    const { fetchImpl } = scripted(['hang'])
    const ac = new AbortController()
    const pending = waitForServer({ ...FAST, attemptTimeoutMs: 10_000, fetchImpl, signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(pending, (e) => e.name === 'AbortError')
  })

  it('an already-cancelled signal makes no request at all', async () => {
    const { fetchImpl, calls } = scripted([ok])
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(waitForServer({ ...FAST, fetchImpl, signal: ac.signal }), (e) => e.name === 'AbortError')
    assert.equal(calls.n, 0)
  })

  it('a non-DropDrop answer (4xx) fails fast instead of waiting', async () => {
    const { fetchImpl, calls } = scripted([() => status(404)])
    const t0 = Date.now()
    await assert.rejects(waitForServer({ ...FAST, timeoutMs: 5000, fetchImpl }), (e) => e.status === 404)
    assert.equal(calls.n, 1)
    assert.ok(Date.now() - t0 < 500)
  })

  it('uses the agreed wording and a ~90 second default deadline', () => {
    assert.equal(WAKE_MESSAGE, 'Waking the DropDrop server. This may take up to a minute.')
    assert.equal(resolveConfig({ env: {}, dev: true }).WAKE_TIMEOUT_MS, 90_000)
  })

  it('the deadline is configurable within sane bounds (a test knob), and invalid values are reported', () => {
    assert.equal(resolveConfig({ env: { VITE_WAKE_TIMEOUT_MS: '8000' }, dev: true }).WAKE_TIMEOUT_MS, 8000)
    for (const bad of ['100', '999999', 'abc', '1.5']) {
      const c = resolveConfig({ env: { VITE_WAKE_TIMEOUT_MS: bad }, dev: true })
      assert.equal(c.WAKE_TIMEOUT_MS, 90_000)
      assert.match(c.errors.join(), /VITE_WAKE_TIMEOUT_MS/)
    }
  })
})
