import { WebSocketServer } from 'ws'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { isDbConnected } from '../config/database.js'
import { clientIpFromRequest } from '../utils/clientIp.js'
import { validateRoomName } from '../utils/validation.js'
import { CollabError, send } from './CollabManager.js'
import {
  CLOSE, MSG_AUTH, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_SYNC,
  encodeAwareness, encodePersistedVector, encodeSyncStep1,
} from './protocol.js'

const WS_PATH_PREFIX = '/ws/'
const MAX_AWARENESS_BYTES = 8 * 1024

/**
 * Attaches the Yjs collaboration endpoint `ws(s)://host/ws/<roomName>` to an HTTP server.
 *
 * Invalid rooms/origins are accepted at the HTTP level and then closed with a 44xx code, because
 * y-websocket clients treat 4400-4499 as permanent and stop retrying (an HTTP-level rejection would
 * make them reconnect in a loop).
 */
export function attachCollabServer(httpServer, manager, options = {}) {
  const {
    allowedOrigins = [],
    maxPayload = 2 * 1024 * 1024, // largest single WebSocket message
    maxConnectionsPerIp = 20,
    maxConnectionsTotal = 1000,
    maxClientsPerRoom = 50,
    messagesPerSecond = 100, // sustained, per connection
    messageBurst = 200,
    newConnectionsPerMinutePerIp = 120,
    pingIntervalMs = 30_000,
    trustProxy = false, // legacy boolean: equivalent to trustProxyHops: 1
    trustProxyHops = 0,
  } = options

  const wss = new WebSocketServer({ noServer: true, maxPayload })
  const perIp = new Map() // ip -> open connection count
  const recentConnects = new Map() // ip -> [timestamps]
  let total = 0

  // Trusted reverse proxies in front of this process (0 = none). `trustProxy: true` means exactly one.
  // X-Forwarded-For is only consulted when proxies are trusted, and only the entry the LAST trusted proxy
  // appended is used, so client-supplied (forged) leading entries cannot dodge per-IP limits.
  const hops = trustProxyHops || (trustProxy ? 1 : 0)
  const clientIp = (req) => clientIpFromRequest(req, hops)

  const onUpgrade = (req, socket, head) => {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      return socket.destroy()
    }
    if (!url.pathname.startsWith(WS_PATH_PREFIX)) return // not ours; let other upgrade handlers (if any) deal with it
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, req, url).catch(() => ws.close(CLOSE.INTERNAL, 'Internal error'))
    })
  }
  httpServer.on('upgrade', onUpgrade)

  async function handleConnection(ws, req, url) {
    ws.on('error', () => {}) // socket errors surface as 'close'; never crash the process

    // --- admission checks (all answered with a close code the client can act on) ---
    const origin = req.headers.origin
    if (origin && !allowedOrigins.includes(origin)) return ws.close(CLOSE.FORBIDDEN_ORIGIN, 'Origin not allowed')

    let roomName
    try {
      roomName = decodeURIComponent(url.pathname.slice(WS_PATH_PREFIX.length))
    } catch {
      return ws.close(CLOSE.BAD_ROOM, 'Invalid room name')
    }
    if (validateRoomName(roomName)) return ws.close(CLOSE.BAD_ROOM, 'Invalid room name')

    const ip = clientIp(req)
    const now = Date.now()
    const stamps = (recentConnects.get(ip) ?? []).filter((t) => now - t < 60_000)
    stamps.push(now)
    recentConnects.set(ip, stamps)
    if (stamps.length > newConnectionsPerMinutePerIp) return ws.close(CLOSE.RATE_LIMITED, 'Too many connections')
    if ((perIp.get(ip) ?? 0) >= maxConnectionsPerIp || total >= maxConnectionsTotal) {
      return ws.close(CLOSE.TRY_AGAIN_LATER, 'Server busy')
    }
    if (!isDbConnected()) return ws.close(CLOSE.TRY_AGAIN_LATER, 'Database unavailable')

    perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
    total++
    let closed = false
    let entry = null
    ws.isAlive = true
    // Persistence acks (MSG_PERSISTED) are opt-in (?persisted-ack=1) so stock y-websocket clients never see an unknown message type.
    ws.wantsAck = url.searchParams.get('persisted-ack') === '1'
    ws.on('pong', () => (ws.isAlive = true))
    ws.on('close', () => {
      if (closed) return
      closed = true
      total--
      const n = (perIp.get(ip) ?? 1) - 1
      if (n <= 0) perIp.delete(ip)
      else perIp.set(ip, n)
      if (entry) {
        manager.detachConnection(entry, ws)
        manager.release(entry)
        entry = null
      }
    })

    // Messages can arrive while the doc is still loading from MongoDB: queue them.
    const queue = []
    let tokens = messageBurst
    let lastRefill = Date.now()
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return ws.close(CLOSE.BAD_MESSAGE, 'Binary messages only')
      const t = Date.now()
      tokens = Math.min(messageBurst, tokens + ((t - lastRefill) / 1000) * messagesPerSecond)
      lastRefill = t
      if (--tokens < 0) return ws.close(CLOSE.RATE_LIMITED, 'Rate limit exceeded')
      const bytes = data instanceof Buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
      if (entry) processMessage(entry, ws, bytes)
      else queue.push(bytes)
    })

    let acquired
    try {
      acquired = await manager.acquire(roomName)
    } catch (err) {
      if (err?.code === 'STORAGE_FULL') return ws.close(CLOSE.STORAGE_FULL, 'Storage nearly full: new rooms are disabled')
      return ws.close(CLOSE.TRY_AGAIN_LATER, 'Could not open room')
    }
    if (closed || acquired.conns.size >= maxClientsPerRoom) {
      manager.release(acquired)
      if (!closed) ws.close(CLOSE.TRY_AGAIN_LATER, 'Room is full')
      return
    }
    entry = acquired
    manager.attachConnection(entry, ws)

    // Initial handshake: sync step 1, current awareness, and what is already durably stored.
    send(ws, encodeSyncStep1(entry.doc))
    const awarenessIds = [...entry.awareness.getStates().keys()]
    if (awarenessIds.length) send(ws, encodeAwareness(entry.awareness, awarenessIds))
    if (ws.wantsAck) send(ws, encodePersistedVector(entry.persistedSV))

    for (const bytes of queue.splice(0)) {
      if (closed) break
      processMessage(entry, ws, bytes)
    }
  }

  function processMessage(entry, ws, bytes) {
    try {
      const decoder = decoding.createDecoder(bytes)
      const type = decoding.readVarUint(decoder)
      switch (type) {
        case MSG_SYNC: {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MSG_SYNC)
          const syncType = decoding.readVarUint(decoder)
          if (syncType === syncProtocol.messageYjsSyncStep1) {
            syncProtocol.readSyncStep1(decoder, encoder, entry.doc)
          } else if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
            manager.applyClientUpdate(entry, decoding.readVarUint8Array(decoder), ws)
          } else {
            throw new CollabError('MALFORMED', 'Unknown sync message')
          }
          if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder))
          break
        }
        case MSG_AWARENESS: {
          const payload = decoding.readVarUint8Array(decoder)
          if (payload.byteLength > MAX_AWARENESS_BYTES) throw new CollabError('TOO_LARGE', 'Awareness too large')
          awarenessProtocol.applyAwarenessUpdate(entry.awareness, payload, ws)
          break
        }
        case MSG_QUERY_AWARENESS: {
          const ids = [...entry.awareness.getStates().keys()]
          if (ids.length) send(ws, encodeAwareness(entry.awareness, ids))
          break
        }
        case MSG_AUTH:
          break // not used: DropDrop has no authentication
        default:
          throw new CollabError('MALFORMED', 'Unknown message type')
      }
    } catch (err) {
      // Never log message contents. Close with a code that tells the client what happened.
      ws.close(err instanceof CollabError && err.code === 'TOO_LARGE' ? CLOSE.TOO_LARGE : CLOSE.BAD_MESSAGE, err instanceof CollabError ? err.message : 'Malformed message')
    }
  }

  // Heartbeat: drop connections that stopped answering pings so their awareness state disappears.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
    const cutoff = Date.now() - 60_000
    for (const [ip, stamps] of recentConnects) {
      if (!stamps.some((t) => t > cutoff)) recentConnects.delete(ip)
    }
  }, pingIntervalMs)
  heartbeat.unref?.()

  return {
    wss,
    connectionCount: () => total,
    /** Close every socket (clients reconnect on their own) and stop accepting upgrades. */
    async close() {
      clearInterval(heartbeat)
      httpServer.off('upgrade', onUpgrade)
      for (const ws of wss.clients) ws.close(CLOSE.GOING_AWAY, 'Server restarting')
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}
