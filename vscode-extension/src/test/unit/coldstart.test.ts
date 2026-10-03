// F1: cold-start handling. A REAL backend (isolated Atlas test database) sits behind a gateway that behaves like a
// sleeping free-tier host (503 / held requests / resets) until it "wakes". Nothing about the waking is mocked inside
// the extension code: it is the real RoomService / CollaborationService talking over real sockets.
import { afterEach, after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { CollaborationService, CollaborationSession } from '../../services/collaborationService'
import { ApiError, RoomService, WAKE_MESSAGE } from '../../services/roomService'
import { requireEndpoints } from '../../utils/urls'
import { BackendHandle, SKIP_REASON, cleanupRooms, startBackend, waitFor } from '../support/backend'
import { GatewayHandle, GatewayOptions, startSleepyGateway } from '../support/sleepyGateway'

const prefix = `ext-cold-${Date.now().toString(36)}`
let n = 0
const room = () => `${prefix}-${++n}`
const FAST = { retryDelayMs: 200, wakingAfterMs: 300, attemptTimeoutMs: 1500 } // keeps the tests quick; behaviour is identical

describe('cold start: the server is asleep when the extension asks', { skip: SKIP_REASON }, () => {
  let backend: BackendHandle
  const gateways: GatewayHandle[] = []
  const services: CollaborationService[] = []
  const extraServers: http.Server[] = []

  const gateway = async (opts: Omit<GatewayOptions, 'targetPort'>) => {
    const g = await startSleepyGateway({ targetPort: backend.port, ...opts })
    gateways.push(g)
    return g
  }
  const via = (g: Pick<GatewayHandle, 'url' | 'wsUrl'>) => {
    const s = new CollaborationService(() => requireEndpoints({ apiUrl: g.url, websocketUrl: g.wsUrl, publicAppUrl: '' }), { maxBackoffTime: 200 })
    services.push(s)
    return s
  }
  const roomPosts = (g: GatewayHandle) => g.forwarded.filter((f) => f.method === 'POST' && f.path === '/api/rooms').length
  const ready = (s: CollaborationSession) => waitFor(() => s.state.phase === 'connected' && s.state.synced, `${s.roomName} connected`, 20_000)

  before(async () => {
    backend = await startBackend()
  })
  afterEach(async () => {
    services.splice(0).forEach((s) => s.dispose())
    await Promise.all(gateways.splice(0).map((g) => g.stop()))
    await Promise.all(extraServers.splice(0).map((s) => new Promise((r) => s.close(r))))
  })
  after(async () => {
    await backend.kill()
    console.log(`cleanup (isolated test database): ${cleanupRooms(prefix)}`)
  })

  for (const mode of ['503', 'hold', 'reset'] as const) {
    it(`waits for a server that answers ${mode === '503' ? '503 "waking up"' : mode === 'hold' ? 'late (requests held)' : 'with connection resets'}, then joins; exactly one room is created`, async () => {
      const g = await gateway({ mode, wakeAfterMs: 2500 })
      const s = via(g)
      let woke = 0
      const t0 = Date.now()
      const { session, created } = await s.join(room(), { ...FAST, onWaking: () => woke++ })
      assert.ok(Date.now() - t0 >= 2000, 'it really waited for the wake-up')
      assert.equal(woke, 1, 'the "waking" message is shown exactly once')
      assert.equal(created, true)
      await ready(session) // and the WebSocket connection works through the woken server
      assert.equal(roomPosts(g), 1, 'retries never created a second room')
      assert.equal(g.forwarded.filter((f) => f.path === '/api/health').length, 1, 'nothing reached the backend until it was awake')
    })
  }

  it('an already-awake server is not slowed down and shows no waking message', async () => {
    const s = via({ url: backend.apiUrl, wsUrl: backend.wsUrl })
    let woke = 0
    const t0 = Date.now()
    const { session } = await s.join(room(), { ...FAST, onWaking: () => woke++ })
    assert.ok(Date.now() - t0 < 2500)
    assert.equal(woke, 0)
    await ready(session)
  })

  it('Cancel stops waiting immediately and sends nothing to the server', async () => {
    const g = await gateway({ mode: '503' }) // never wakes
    const s = via(g)
    const ac = new AbortController()
    let woke = false
    const pending = s.join(room(), { ...FAST, signal: ac.signal, onWaking: () => (woke = true) })
    await waitFor(() => woke, 'waking message shown', 5000)
    const t0 = Date.now()
    ac.abort()
    await assert.rejects(pending, (e: Error) => e.name === 'AbortError')
    assert.ok(Date.now() - t0 < 1000, 'cancellation is prompt')
    assert.equal(s.session, null)
    assert.equal(g.forwarded.length, 0, 'nothing reached the backend')
    assert.equal(roomPosts(g), 0)
  })

  it('gives up after the deadline with a clear, non-technical error (and still creates nothing)', async () => {
    const g = await gateway({ mode: '503' })
    const s = via(g)
    const t0 = Date.now()
    await assert.rejects(s.join(room(), { ...FAST, timeoutMs: 1500 }), (e: ApiError) => e.code === 'SERVER_WAKE_TIMEOUT' && /didn't respond within 2 seconds/.test(e.message) && /try again/i.test(e.message))
    assert.ok(Date.now() - t0 < 4000)
    assert.equal(s.session, null)
    assert.equal(g.forwarded.length, 0)
  })

  const closedPort = () =>
    new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as net.AddressInfo
        srv.close(() => resolve(port)) // a port that was free a moment ago and has nothing listening
      })
    })

  it('a refused connection (nothing listening) fails FAST instead of waiting 90 seconds', async () => {
    const port = await closedPort()
    const s = via({ url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` })
    const t0 = Date.now()
    await assert.rejects(s.join(room()), (e: ApiError) => e.status === 0 && e.code === 'NETWORK' && /dropdrop\.apiUrl/.test(e.message))
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`)
  })

  it('a blocked port or malformed address also fails fast (configuration mistakes are not "sleeping servers")', async () => {
    for (const url of ['http://127.0.0.1:9', 'not a url']) {
      const t0 = Date.now()
      await assert.rejects(new RoomService(url).waitUntilAwake({ ...FAST, timeoutMs: 20_000 }), (e: ApiError) => e.status === 0, url)
      assert.ok(Date.now() - t0 < 3000, `${url} took ${Date.now() - t0} ms`)
    }
  })

  it('a server that is up but is not DropDrop (404 on the health check) fails fast', async () => {
    const other = http.createServer((_req, res) => res.writeHead(404).end('nope'))
    extraServers.push(other)
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    const port = (other.address() as { port: number }).port
    const s = via({ url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` })
    const t0 = Date.now()
    await assert.rejects(s.join(room()), (e: ApiError) => e.status === 404)
    assert.ok(Date.now() - t0 < 2000)
  })

  it('joining the same room twice while the server sleeps shares ONE attempt: one session, one create request', async () => {
    const g = await gateway({ mode: '503', wakeAfterMs: 2000 })
    const s = via(g)
    const r = room()
    const [a, b] = await Promise.all([s.join(r, FAST), s.join(r, FAST)])
    assert.equal(a.session, b.session)
    assert.equal(roomPosts(g), 1)
    await ready(a.session)
  })

  it('switching to a different room while waiting cancels the first attempt and creates only the second room', async () => {
    const g = await gateway({ mode: '503', wakeAfterMs: 2000 })
    const s = via(g)
    const first = room()
    const second = room()
    const p1 = s.join(first, FAST)
    p1.catch(() => {})
    await new Promise((r) => setTimeout(r, 400))
    const p2 = s.join(second, FAST)
    await assert.rejects(p1, (e: Error) => e.name === 'AbortError')
    const { session } = await p2
    assert.equal(session.roomName, second)
    assert.equal(roomPosts(g), 1, 'only the room the user ended up choosing was created')
    assert.equal(await new RoomService(backend.apiUrl).getRoom(first).catch((e: ApiError) => e.status), 404, 'the abandoned room does not exist')
  })

  it('leaving while waiting aborts the wait', async () => {
    const g = await gateway({ mode: '503' })
    const s = via(g)
    const pending = s.join(room(), FAST)
    pending.catch(() => {})
    await new Promise((r) => setTimeout(r, 400))
    s.leave()
    await assert.rejects(pending, (e: Error) => e.name === 'AbortError')
    assert.equal(g.forwarded.length, 0)
  })

  it('the wake message text is the agreed wording', () => {
    assert.equal(WAKE_MESSAGE, 'Waking the DropDrop server. This may take up to a minute.')
  })
})
