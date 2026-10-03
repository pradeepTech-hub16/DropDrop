// Cold-start handling for a free-tier backend that sleeps when idle (e.g. Render Free: ~1 minute to wake).
//
// waitForServer() polls GET /api/health, which is read-only, so retrying can never create rooms or duplicate
// anything. It is only the "is the server up yet?" question; the (idempotent) room request happens afterwards.
import { ApiError } from './api.js'
import { config } from './config.js'

// NOTE: a browser cannot tell "the server rejected this website's address (CORS)" from "the server is asleep":
// both are just a failed request. A misconfigured origin therefore shows the waking message until the deadline,
// and the final error mentions that possibility.
export const WAKE_MESSAGE = 'Waking the DropDrop server. This may take up to a minute.'

export class WakeTimeoutError extends Error {
  constructor(ms) {
    super(`The DropDrop server didn’t respond within ${Math.round(ms / 1000)} seconds. It may be down, your connection may be offline, or the server may not allow this website’s address. Please try again.`)
    this.name = 'WakeTimeoutError'
    this.code = 'SERVER_WAKE_TIMEOUT'
  }
}

const abortError = () => new DOMException('Cancelled', 'AbortError')
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError()
}
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      done()
      reject(abortError())
    }
    const timer = setTimeout(() => {
      done()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Resolves as soon as the server answers its health check with status "ok".
 *  - Network errors, per-attempt timeouts, 5xx/408/429 (asleep, starting, database still connecting) are treated as
 *    "not ready yet" and retried, up to `timeoutMs` (default ~90 s).
 *  - Other 4xx answers mean the server is up but this is not a DropDrop API: fail fast (wrong address), no waiting.
 *  - `onWaking` is called once, as soon as it is clear the server is not answering promptly (after the first failed
 *    attempt, or when an attempt is still pending after `wakingAfterMs`).
 *  - `signal` cancels at any moment (rejects with an AbortError, no further requests are made).
 */
export async function waitForServer({
  apiUrl = config.API_URL,
  signal,
  timeoutMs = config.WAKE_TIMEOUT_MS,
  attemptTimeoutMs = 8000,
  retryDelayMs = 1500,
  wakingAfterMs = 2500,
  onWaking,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const deadline = Date.now() + timeoutMs
  let notified = false
  const notify = () => {
    if (!notified) {
      notified = true
      onWaking?.()
    }
  }
  const slowTimer = setTimeout(notify, wakingAfterMs)
  try {
    for (;;) {
      throwIfAborted(signal)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new WakeTimeoutError(timeoutMs)

      const attempt = new AbortController()
      const onAbort = () => attempt.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const attemptTimer = setTimeout(() => attempt.abort(), Math.min(attemptTimeoutMs, remaining))
      try {
        const res = await fetchImpl(`${apiUrl}/api/health`, { signal: attempt.signal, cache: 'no-store' })
        if (res.ok) {
          const body = await res.json().catch(() => null)
          if (body?.status === 'ok') return { waited: notified }
          // 200 but not our health payload (e.g. a hosting "waking up" page): keep waiting
        } else if (!(res.status >= 500 || res.status === 408 || res.status === 429)) {
          throw new ApiError(res.status, 'HTTP_ERROR', `The server answered ${res.status} to the health check. Check the server address.`)
        }
      } catch (err) {
        if (err instanceof ApiError) throw err
        throwIfAborted(signal) // user cancelled: stop; anything else (network error, attempt timeout) means "not ready"
      } finally {
        clearTimeout(attemptTimer)
        signal?.removeEventListener('abort', onAbort)
      }
      notify()
      await sleep(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())), signal)
    }
  } finally {
    clearTimeout(slowTimer)
  }
}
