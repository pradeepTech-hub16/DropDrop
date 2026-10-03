import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as decoding from 'lib0/decoding'

import { config } from './config.js'

export const WS_URL = config.WS_URL

// DropDrop protocol extension: the server tells us which state vector is durably stored in MongoDB.
const MSG_PERSISTED = 10

// Close codes 4400-4499 are permanent: the provider stops reconnecting (the server refused us for a reason).
export const CLOSE_MESSAGES = {
  4400: 'This room name isn’t valid.',
  4401: 'The server rejected a message from this tab. Reload the page to continue.',
  4403: 'The server doesn’t allow connections from this website address.',
  4409: 'DropDrop’s free storage is nearly full, so new rooms are temporarily disabled. Existing rooms keep working; try again later.',
  4413: 'This room reached its size limit, so new edits can’t be saved. Remove some text, then reconnect.',
  4429: 'Too many requests from this connection. Wait a moment, then reconnect.',
}

const ADJECTIVES = ['Swift', 'Calm', 'Bright', 'Quiet', 'Lucky', 'Brave', 'Witty', 'Mellow', 'Nimble', 'Sunny']
const ANIMALS = ['Fox', 'Otter', 'Heron', 'Lynx', 'Panda', 'Falcon', 'Gecko', 'Koala', 'Raven', 'Seal']
const COLORS = ['#3ddc97', '#4cc9f0', '#f72585', '#ffb703', '#b388ff', '#ff7f50', '#80ed99', '#ffd166']
const pick = (list) => list[Math.floor(Math.random() * list.length)]

/** A throwaway, per-tab display identity. Not an account: nothing is stored on the server. */
function anonymousIdentity() {
  try {
    const saved = sessionStorage.getItem('dropdrop:identity')
    if (saved) return JSON.parse(saved)
  } catch {
    /* sessionStorage unavailable */
  }
  const color = pick(COLORS)
  const identity = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color, colorLight: `${color}33` }
  try {
    sessionStorage.setItem('dropdrop:identity', JSON.stringify(identity))
  } catch {
    /* ignore */
  }
  return identity
}

/**
 * One shared document per room: Y.Text "content" + Y.Map "meta" (language), synced through the backend.
 * Cross-tab BroadcastChannel is disabled so every change genuinely goes through the server.
 */
export function createCollab(roomName) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(WS_URL, roomName, doc, {
    disableBc: true,
    params: { 'persisted-ack': '1' },
  })
  const collab = {
    doc,
    provider,
    ytext: doc.getText('content'),
    meta: doc.getMap('meta'),
    awareness: provider.awareness,
    persisted: new Map(), // last state vector the server confirmed as stored
    /** True when every local change is covered by the server's last persistence ack. */
    isPersisted() {
      for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
        if ((collab.persisted.get(client) ?? 0) < clock) return false
      }
      return true
    },
    destroy() {
      provider.awareness.setLocalState(null)
      provider.destroy()
      doc.destroy()
    },
  }
  provider.messageHandlers[MSG_PERSISTED] = (_encoder, decoder) => {
    collab.persisted = Y.decodeStateVector(decoding.readVarUint8Array(decoder))
    collab.onPersisted?.()
  }
  provider.awareness.setLocalStateField('user', anonymousIdentity())
  return collab
}
