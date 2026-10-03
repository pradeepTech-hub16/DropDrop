import http from 'node:http'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { createApp } from '../src/app.js'
import { CollabManager } from '../src/collab/CollabManager.js'
import { attachCollabServer } from '../src/collab/wsServer.js'

export const ORIGIN = 'http://localhost:5173'

/** Poll until `cond()` is truthy (deterministic: no fixed sleeps for correctness). */
export async function waitFor(cond, { timeout = 8000, interval = 10, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await cond()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, interval))
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A real HTTP + WebSocket collaboration server on an ephemeral port. */
export async function startServer({ manager = {}, ws = {}, port: wantedPort = 0 } = {}) {
  const collab = new CollabManager({ flushIntervalMs: 50, unloadGraceMs: 100, log: () => {}, ...manager })
  const app = createApp({ clientUrl: ORIGIN, collab })
  const server = http.createServer(app)
  const wsApi = attachCollabServer(server, collab, { allowedOrigins: [ORIGIN], ...ws })
  await new Promise((r) => server.listen(wantedPort, '127.0.0.1', r))
  const port = server.address().port
  let crashed = false
  return {
    collab, app, server, wsApi, port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (crashed) return // a crashed process has nothing left to shut down (its persistence queue is frozen)
      await wsApi.close()
      await collab.shutdown()
      await new Promise((r) => server.close(r))
    },
    /** Simulate a crash: drop sockets and stop serving WITHOUT flushing or snapshotting. */
    async crash() {
      crashed = true
      // A real crash performs NO further writes. Freeze every room's persistence queue first, otherwise the
      // "last client left, flush now" handlers triggered by the dying sockets would still reach the database.
      for (const entry of collab.entries.values()) {
        clearTimeout(entry.flushTimer)
        clearTimeout(entry.unloadTimer)
        entry.chain = new Promise(() => {}) // never settles: everything enqueued afterwards simply never runs
        entry.awareness.destroy() // a dead process has no timers: stop the presence interval so the test process can exit
        entry.doc.destroy()
      }
      for (const s of wsApi.wss.clients) s.terminate()
      clearAllTimers(collab)
      await new Promise((r) => server.close(r))
    },
  }
}

function clearAllTimers(collab) {
  for (const entry of collab.entries.values()) {
    clearTimeout(entry.flushTimer)
    clearTimeout(entry.unloadTimer)
  }
  collab.closed = true
}

/** A real y-websocket client (the same provider the browser uses), run in Node via the `ws` package. */
export function connectClient(server, room, { maxBackoffTime = 50, params = {} } = {}) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(server.wsUrl, room, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    maxBackoffTime,
    params,
  })
  const client = {
    doc, provider,
    text: doc.getText('content'),
    meta: doc.getMap('meta'),
    persistedSV: null,
    closes: [],
    get value() { return this.text.toString() },
    async ready() {
      await waitFor(() => provider.wsconnected && provider.synced, { label: `client sync in ${room}` })
      return this
    },
    destroy() { provider.destroy(); doc.destroy() },
  }
  provider.on('connection-close', (ev) => ev && client.closes.push(ev.code))
  return client
}

/** Raw socket for protocol-abuse tests. Resolves with the close code. */
export function rawSocket(server, path, { headers } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers })
  ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  ws.on('error', () => {})
  ws.opened = new Promise((resolve) => ws.on('open', resolve))
  return ws
}
