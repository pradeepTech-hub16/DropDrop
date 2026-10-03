// REST client for the existing DropDrop API (no vscode dependency).

export interface RoomRecord {
  roomName: string
  content: string
  language: string
  createdAt: string
  updatedAt: string
}

export const WAKE_MESSAGE = 'Waking the DropDrop server. This may take up to a minute.'
export const WAKE_TIMEOUT_MS = 90_000

export class ApiError extends Error {
  /** HTTP status, or 0 when the server could not be reached at all. */
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class WakeTimeoutError extends ApiError {
  constructor(ms: number) {
    super(0, 'SERVER_WAKE_TIMEOUT', `The DropDrop server didn't respond within ${Math.round(ms / 1000)} seconds. It may be down, or your connection may be offline. Please try again.`)
    this.name = 'WakeTimeoutError'
  }
}

export interface WakeOptions {
  /** Cancels waiting at any moment (rejects with an AbortError). */
  signal?: AbortSignal
  /** Called once, as soon as it is clear the server is not answering promptly (a sleeping free-tier host). */
  onWaking?: () => void
  timeoutMs?: number
  attemptTimeoutMs?: number
  retryDelayMs?: number
  wakingAfterMs?: number
}

// "Nothing is listening / the name does not exist" means the configured address is wrong: fail fast instead of
// waiting 90 seconds. A sleeping hosted server never refuses connections, it answers late or with 5xx.
const WRONG_ADDRESS_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL'])

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' })
const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError()
}
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export class RoomService {
  constructor(
    private readonly apiUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs)
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (err) {
      if (signal?.aborted) throw abortError() // cancelled by the caller: not a network failure
      throw new ApiError(0, 'NETWORK', `Can't reach the DropDrop server at ${this.apiUrl}. Is it running, and is dropdrop.apiUrl correct?`)
    }
    let data: any = null
    try {
      data = await res.json()
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      throw new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.message ?? `Server responded with ${res.status}.`)
    }
    return data as T
  }

  /**
   * Waits until the server answers its (read-only) health check. Safe to retry: it never creates anything.
   *  - network errors, per-attempt timeouts and 5xx/408/429 (asleep, starting, database still connecting) are retried
   *    for up to `timeoutMs` (default ~90 s);
   *  - a refused connection or unknown host fails immediately (wrong address);
   *  - another 4xx fails immediately (this is not a DropDrop API).
   */
  async waitUntilAwake(opts: WakeOptions = {}): Promise<{ waited: boolean }> {
    const { signal, onWaking, timeoutMs = WAKE_TIMEOUT_MS, attemptTimeoutMs = 8000, retryDelayMs = 1500, wakingAfterMs = 2500 } = opts
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
        try {
          const attempt = AbortSignal.timeout(Math.min(attemptTimeoutMs, remaining))
          const res = await fetch(`${this.apiUrl}/api/health`, { signal: signal ? AbortSignal.any([signal, attempt]) : attempt, cache: 'no-store' })
          if (res.ok) {
            const body: any = await res.json().catch(() => null)
            if (body?.status === 'ok') return { waited: notified }
            // 200 but not our health payload (e.g. a hosting "waking up" page): keep waiting
          } else if (!(res.status >= 500 || res.status === 408 || res.status === 429)) {
            throw new ApiError(res.status, 'HTTP_ERROR', `The server answered ${res.status} to the health check. Is dropdrop.apiUrl correct?`)
          }
        } catch (err) {
          if (err instanceof ApiError) throw err
          throwIfAborted(signal) // cancelled by the caller
          const cause = (err as { cause?: { code?: string; message?: string } })?.cause
          // Node refuses blocked ports ('bad port') and malformed URLs before connecting: also a wrong address
          const wrongAddress = (cause?.code && WRONG_ADDRESS_CODES.has(cause.code)) || /^bad port$/i.test(cause?.message ?? '') || /invalid url/i.test((err as Error)?.message ?? '')
          if (wrongAddress) {
            throw new ApiError(0, 'NETWORK', `Can't reach the DropDrop server at ${this.apiUrl}. Is it running, and is dropdrop.apiUrl correct?`)
          }
          // anything else (reset, timeout, TLS handshake while waking, ...) means "not ready yet"
        }
        notify()
        await sleep(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())), signal)
      }
    } finally {
      clearTimeout(slowTimer)
    }
  }

  /** Create the room if missing, otherwise return it (idempotent: safe to repeat). */
  async createRoom(roomName: string, signal?: AbortSignal): Promise<{ room: RoomRecord; created: boolean }> {
    return this.request('POST', '/api/rooms', { roomName }, signal)
  }

  async getRoom(roomName: string, signal?: AbortSignal): Promise<RoomRecord> {
    return (await this.request<{ room: RoomRecord }>('GET', `/api/rooms/${encodeURIComponent(roomName)}`, undefined, signal)).room
  }

  /** Same semantics as the website: load the room, creating it first if the name is new. */
  async openRoom(roomName: string, signal?: AbortSignal): Promise<{ room: RoomRecord; created: boolean }> {
    try {
      return { room: await this.getRoom(roomName, signal), created: false }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return this.createRoom(roomName, signal)
      throw err
    }
  }

  async health(): Promise<{ status: string; database: string }> {
    return this.request('GET', '/api/health')
  }
}
