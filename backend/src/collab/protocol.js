// Wire protocol = the standard y-websocket protocol (so y-websocket's WebsocketProvider works as a client)
// plus one DropDrop extension: MSG_PERSISTED.
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_AUTH = 2
export const MSG_QUERY_AWARENESS = 3
/** DropDrop extension (server -> client): payload = varUint8Array state vector that is durably stored. */
export const MSG_PERSISTED = 10

// WebSocket close codes. 4400-4499 are treated as PERMANENT by y-websocket clients (no auto-reconnect).
export const CLOSE = {
  GOING_AWAY: 1001,
  TRY_AGAIN_LATER: 1013, // transient: client reconnects with backoff
  INTERNAL: 1011,
  BAD_ROOM: 4400,
  BAD_MESSAGE: 4401,
  FORBIDDEN_ORIGIN: 4403,
  STORAGE_FULL: 4409, // permanent: new rooms are disabled while storage is nearly full (existing rooms still work)
  TOO_LARGE: 4413,
  RATE_LIMITED: 4429,
}

export function encodeSyncStep1(doc) {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, MSG_SYNC)
  syncProtocol.writeSyncStep1(e, doc)
  return encoding.toUint8Array(e)
}

export function encodeSyncUpdate(update) {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, MSG_SYNC)
  syncProtocol.writeUpdate(e, update)
  return encoding.toUint8Array(e)
}

export function encodeAwareness(awareness, clients) {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, MSG_AWARENESS)
  encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(e)
}

export function encodePersisted(doc) {
  return encodePersistedVector(Y.encodeStateVector(doc))
}

export function encodePersistedVector(stateVector) {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, MSG_PERSISTED)
  encoding.writeVarUint8Array(e, stateVector)
  return encoding.toUint8Array(e)
}
