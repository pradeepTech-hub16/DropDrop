// Integration tests of the extension's real service layer against the REAL backend process and the isolated
// Atlas database "dropdrop_test". Nothing is mocked: every assertion about syncing is observed on a second,
// independent client connection through the server.
import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { CollaborationService, CollaborationSession, SessionState } from '../../services/collaborationService'
import { ApiError, RoomService } from '../../services/roomService'
import { WebviewRelay } from '../../services/webviewRelay'
import { toBase64 } from '../../shared/codec'
import { ConfigError, requireEndpoints } from '../../utils/urls'
import { ROOM_CONTENT_MAX } from '../../utils/validation'
import { BackendHandle, SKIP_REASON, cleanupRooms, sleep, startBackend, waitFor } from '../support/backend'

const prefix = `ext-it-${Date.now().toString(36)}`
let n = 0
const room = () => `${prefix}-${++n}`

describe('extension services against the real backend', { skip: SKIP_REASON }, () => {
  let backend: BackendHandle
  const services: CollaborationService[] = []

  const endpointsFor = (b: Pick<BackendHandle, 'apiUrl' | 'wsUrl'>) => () =>
    requireEndpoints({ apiUrl: b.apiUrl, websocketUrl: b.wsUrl, publicAppUrl: 'https://my-dropdrop.vercel.app' })
  const service = (b: Pick<BackendHandle, 'apiUrl' | 'wsUrl'> = backend) => {
    const s = new CollaborationService(endpointsFor(b), { maxBackoffTime: 200 })
    services.push(s)
    return s
  }
  const ready = (s: CollaborationSession) =>
    waitFor(() => s.state.phase === 'connected' && s.state.synced, `session ${s.roomName} connected+synced`)

  before(async () => {
    backend = await startBackend()
  })
  // Dispose every session after each test (the server allows 20 concurrent connections per IP).
  afterEach(() => services.splice(0).forEach((s) => s.dispose()))
  after(async () => {
    services.forEach((s) => s.dispose())
    await backend.kill()
    console.log(`cleanup (isolated test database): ${cleanupRooms(prefix)}`)
  })

  describe('room creation and joining (4, 5)', () => {
    it('REST: creating a room reports created:true, then created:false for an existing room', async () => {
      const rooms = new RoomService(backend.apiUrl)
      const r = room()
      const first = await rooms.createRoom(r)
      assert.equal(first.created, true)
      assert.equal(first.room.roomName, r)
      assert.equal((await rooms.createRoom(r)).created, false)
      assert.equal((await rooms.getRoom(r)).content, '')
    })

    it('join creates a brand-new room and connects to its Yjs document', async () => {
      const s = service()
      const r = room()
      const { session, created } = await s.join(r)
      assert.equal(created, true)
      assert.equal(session.roomName, r)
      await ready(session)
      assert.equal((await new RoomService(backend.apiUrl).getRoom(r)).roomName, r)
    })

    it('join an existing room loads its saved content', async () => {
      const r = room()
      const a = service()
      const { session: sa } = await a.join(r)
      await ready(sa)
      sa.ytext.insert(0, 'saved earlier')
      await waitFor(() => sa.state.persisted, 'persisted ack')
      const b = service()
      const { session: sb, created } = await b.join(r)
      assert.equal(created, false)
      await ready(sb)
      assert.equal(sb.text, 'saved earlier')
    })

    it('joining the same room twice returns the same live session', async () => {
      const s = service()
      const r = room()
      const one = (await s.join(r)).session
      assert.equal((await s.join(r)).session, one)
    })

    it('rejects invalid room names before touching the network', async () => {
      const s = service({ apiUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9' }) // unreachable on purpose
      await assert.rejects(s.join('bad name'), (e) => e instanceof RangeError && /letters, numbers/.test((e as Error).message))
      await assert.rejects(s.join(''), RangeError)
      await assert.rejects(s.join('x'.repeat(65)), RangeError)
    })
  })

  describe('WebSocket connection and status honesty (9)', () => {
    it('never reports "connected" before the WebSocket is actually open', async () => {
      const s = service()
      const seen: Array<{ phase: string; open: boolean }> = []
      s.on('state', () => {
        const sess = s.session
        if (sess) seen.push({ phase: sess.state.phase, open: sess.provider.wsconnected })
      })
      const { session } = await s.join(room())
      assert.notEqual(session.state.phase, 'connected', 'must start as connecting')
      await ready(session)
      assert.ok(seen.length > 0)
      for (const x of seen) if (x.phase === 'connected') assert.equal(x.open, true, 'connected state must imply an open socket')
    })
  })

  describe('Yjs synchronisation and isolation (11, 12)', () => {
    it('two sessions edit the same room in both directions', async () => {
      const r = room()
      const a = (await service().join(r)).session
      const b = (await service().join(r)).session
      await Promise.all([ready(a), ready(b)])
      a.ytext.insert(0, 'hello from A')
      await waitFor(() => b.text === 'hello from A', 'B receives A')
      b.ytext.insert(b.ytext.length, ' + B')
      await waitFor(() => a.text === 'hello from A + B', 'A receives B')
    })

    it('simultaneous offline edits merge without loss', async () => {
      const r = room()
      const a = (await service().join(r)).session
      const b = (await service().join(r)).session
      await Promise.all([ready(a), ready(b)])
      a.ytext.insert(0, 'base')
      await waitFor(() => b.text === 'base', 'base synced')
      a.provider.disconnect()
      b.provider.disconnect()
      a.ytext.insert(0, 'A-')
      b.ytext.insert(b.ytext.length, '-B')
      a.provider.connect()
      b.provider.connect()
      await waitFor(() => a.text === b.text && a.text.includes('A-') && a.text.includes('-B'), 'merged')
    })

    it('language and presence are shared; presence is real', async () => {
      const r = room()
      const a = (await service().join(r)).session
      const b = (await service().join(r)).session
      await Promise.all([ready(a), ready(b)])
      a.setLanguage('python')
      await waitFor(() => b.state.language === 'python', 'language synced')
      await waitFor(() => a.state.peers.length === 2 && b.state.peers.length === 2, 'both see 2 participants')
      assert.deepEqual(a.state.peers.map((p) => p.isSelf).sort(), [false, true])
      assert.ok(a.state.peers.every((p) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(p.name)), 'anonymous generated labels, no personal data')
    })

    it('different rooms stay isolated', async () => {
      const r1 = room(), r2 = room()
      const a = (await service().join(r1)).session
      const b = (await service().join(r2)).session
      await Promise.all([ready(a), ready(b)])
      a.ytext.insert(0, 'only room one')
      b.ytext.insert(0, 'only room two')
      await waitFor(() => a.state.persisted && b.state.persisted, 'both persisted')
      await sleep(200)
      assert.equal(a.text, 'only room one')
      assert.equal(b.text, 'only room two')
      assert.equal(a.state.peers.length, 1)
      const c = (await service().join(r2)).session
      await ready(c)
      assert.equal(c.text, 'only room two')
    })

    it('the saved indicator turns true only after the server persists the edit', async () => {
      const a = (await service().join(room())).session
      await ready(a)
      a.ytext.insert(0, 'x')
      assert.equal(a.state.persisted, false, 'unsaved immediately after typing')
      await waitFor(() => a.state.persisted, 'server persistence ack')
    })
  })

  describe('webview relay (the editor webview ↔ shared document)', () => {
    it('webview edits reach other clients; malformed webview messages are ignored', async () => {
      const r = room()
      const hostSession = (await service().join(r)).session
      const other = (await service().join(r)).session
      await Promise.all([ready(hostSession), ready(other)])
      const posted: any[] = []
      const hostIdBefore = hostSession.clientId
      const relay = new WebviewRelay(hostSession, (m) => posted.push(m), { copyText() {}, copyLink() {}, reconnect() {}, leave() {} })
      relay.handle({ type: 'ready' })
      assert.equal(posted[0].type, 'init')

      // A replica doc (as the webview has) produces a real Yjs update.
      const replica = new Y.Doc()
      Y.applyUpdate(replica, Buffer.from(posted[0].state, 'base64'))
      let captured: Uint8Array | null = null
      replica.on('update', (u: Uint8Array) => (captured = u))
      replica.getText('content').insert(0, 'typed in the webview')
      relay.handle({ type: 'update', update: toBase64(captured!) })
      await waitFor(() => other.text === 'typed in the webview', 'other client receives webview edit')
      // Regression: the webview replica must not share the host's Yjs client id (Yjs would rename the host doc).
      assert.equal(hostSession.clientId, hostIdBefore)
      assert.equal(hostSession.provider.awareness.clientID, hostSession.clientId)

      const before = other.text
      for (const junk of [null, 42, 'x', {}, { type: 'update' }, { type: 'update', update: 123 }, { type: 'localState', state: 5 }, { type: 'setLanguage', language: 'klingon' }, { type: 'nope' }]) {
        assert.doesNotThrow(() => relay.handle(junk))
      }
      await sleep(150)
      assert.equal(other.text, before)
      assert.notEqual(hostSession.state.language, 'klingon')

      // edits from other clients are forwarded to the webview
      posted.length = 0
      other.ytext.insert(other.ytext.length, '!')
      await waitFor(() => posted.some((m) => m.type === 'update'), 'update forwarded to webview')
      relay.dispose()
    })

    it('an oversized document is refused by the server and surfaced as a closed state', async () => {
      const r = room()
      const s = (await service().join(r)).session
      await ready(s)
      const states: SessionState[] = []
      s.on('state', (st) => states.push(st))
      s.ytext.insert(0, 'a'.repeat(ROOM_CONTENT_MAX + 1000))
      await waitFor(() => s.state.phase === 'closed', 'server closes the connection (4413)')
      assert.match(s.state.closeMessage ?? '', /size limit/)
    })
  })

  describe('API failure and configuration errors (8)', () => {
    const dead = { apiUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9' }
    it('unreachable backend: a clear ApiError(0) and no half-created session', async () => {
      const s = service(dead)
      await assert.rejects(s.join(room()), (e) => e instanceof ApiError && e.status === 0 && /dropdrop\.apiUrl/.test(e.message))
      assert.equal(s.session, null)
    })
    it('nonexistent room: 404 ROOM_NOT_FOUND from the real API', async () => {
      await assert.rejects(new RoomService(backend.apiUrl).getRoom(`${prefix}-never-created`), (e) => e instanceof ApiError && e.status === 404 && e.code === 'ROOM_NOT_FOUND')
    })
    it('invalid settings produce a ConfigError that lists the problems', async () => {
      const s = new CollaborationService(() => requireEndpoints({ apiUrl: 'nope', websocketUrl: 'nope', publicAppUrl: 'nope' }))
      services.push(s)
      await assert.rejects(s.join(room()), (e) => e instanceof ConfigError && e.problems.length === 3)
    })
    it('the real health endpoint is reachable', async () => {
      assert.equal((await new RoomService(backend.apiUrl).health()).database, 'connected')
    })
  })

  describe('leaving and resource cleanup (6, 13)', () => {
    it('leave disconnects, disposes Yjs resources, removes presence, and keeps server data', async () => {
      const r = room()
      const sa = service()
      const a = (await sa.join(r)).session
      const b = (await service().join(r)).session
      await Promise.all([ready(a), ready(b)])
      a.ytext.insert(0, 'survives leaving')
      await waitFor(() => a.state.persisted && b.text === 'survives leaving', 'persisted and visible')
      await waitFor(() => b.state.peers.length === 2, 'B sees A')

      sa.leave()
      assert.equal(sa.session, null)
      assert.equal(a.isDisposed, true)
      assert.equal(a.provider.wsconnected, false)
      assert.equal(a.provider.shouldConnect, false)
      assert.equal((a.doc as any).isDestroyed, true)
      assert.equal(a.listenerCount('state'), 0)
      await waitFor(() => b.state.peers.length === 1, "A's presence removed on the server")

      const again = (await sa.join(r)).session
      await ready(again)
      assert.equal(again.text, 'survives leaving')
    })

    it('leave is idempotent and safe when not in a room', () => {
      const s = service()
      assert.doesNotThrow(() => {
        s.leave()
        s.leave()
      })
    })

    it('repeated join/leave cycles do not leak sessions or connections', async () => {
      const r = room()
      const watcher = (await service().join(r)).session
      await ready(watcher)
      const s = service()
      const sessions: CollaborationSession[] = []
      for (let i = 0; i < 12; i++) {
        sessions.push((await s.join(r)).session)
        s.leave()
      }
      assert.ok(sessions.every((x) => x.isDisposed && !x.provider.wsconnected))
      await waitFor(() => watcher.state.peers.length === 1, 'all server-side connections closed')
    })
  })

  describe('reconnection and recovery (10)', () => {
    it('survives a backend outage: offline edits are kept and synced after the server returns', async () => {
      const r = room()
      const port = backend.port
      const a = (await service().join(r)).session
      await ready(a)
      a.ytext.insert(0, 'before outage')
      await waitFor(() => a.state.persisted, 'persisted before the crash')

      await backend.kill() // hard stop, like a crash
      await waitFor(() => a.state.phase === 'disconnected' || a.state.phase === 'reconnecting', 'outage detected')
      assert.notEqual(a.state.phase, 'connected')
      a.ytext.insert(a.ytext.length, ' + offline edit')
      assert.equal(a.state.persisted, false, 'offline edits are shown as unsaved')

      backend = await startBackend({ port })
      await waitFor(() => a.state.phase === 'connected' && a.state.synced, 'auto-reconnect', 60_000)
      await waitFor(() => a.state.persisted, 'offline edit persisted after reconnect', 30_000)

      const late = (await service().join(r)).session // brand-new client after the restart
      await ready(late)
      assert.equal(late.text, 'before outage + offline edit')
    })

    it('"restart the extension": a fresh service recovers the saved document', async () => {
      const r = room()
      const first = service()
      const a = (await first.join(r)).session
      await ready(a)
      a.ytext.insert(0, 'recover me ✓')
      await waitFor(() => a.state.persisted, 'persisted')
      first.dispose() // simulates extension deactivation / VS Code closing
      assert.equal(a.isDisposed, true)
      const second = service() // simulates a new VS Code window
      const b = (await second.join(r)).session
      await ready(b)
      assert.equal(b.text, 'recover me ✓')
    })
  })
})
