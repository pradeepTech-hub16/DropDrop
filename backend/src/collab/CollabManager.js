import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { StorageFullError } from '../services/storageGuard.js'
import Room from '../models/Room.js'
import RoomUpdate from '../models/RoomUpdate.js'
import { LANGUAGES, MAX_CONTENT_LENGTH } from '../utils/validation.js'
import { encodeAwareness, encodePersistedVector, encodeSyncUpdate } from './protocol.js'

export class CollabError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code // 'TOO_LARGE' | 'MALFORMED'
  }
}

const OPEN = 1 // ws.OPEN
export function send(ws, message) {
  if (ws.readyState === OPEN) ws.send(message, (err) => err && ws.terminate())
}

/**
 * Owns one Y.Doc per room (keyed by room name) and its persistence in MongoDB.
 *
 * Persistence model (all in the same Atlas database as the REST API):
 *   Room.yjsState     snapshot: Y.encodeStateAsUpdate(doc) at the last compaction
 *   RoomUpdate        append-only log of batched updates since that snapshot
 *   Room.content/language  plain-text mirror of the doc (what REST GET returns)
 * Load = snapshot + every logged update (Yjs merges them; duplicates are harmless).
 * Writes are batched: at most one log insert (+ one Room mirror update) per room per `flushIntervalMs`.
 */
export class CollabManager {
  constructor({
    flushIntervalMs = 1000,
    compactEvery = 100, // fold the log into a snapshot after this many batches
    unloadGraceMs = 30_000, // keep an idle doc in memory this long before freeing it
    maxDocBytes = 8 * 1024 * 1024, // cap on the encoded document (also guards against junk root types)
    maxUpdateBytes = 1024 * 1024,
    maxContentLength = MAX_CONTENT_LENGTH,
    storageGuard = null, // optional StorageGuard: refuses to create NEW rooms when storage is nearly full
    log = (...a) => console.log('[collab]', ...a),
  } = {}) {
    Object.assign(this, { flushIntervalMs, compactEvery, unloadGraceMs, maxDocBytes, maxUpdateBytes, maxContentLength, storageGuard, log })
    this.entries = new Map()
    this.loading = new Map()
    this.closed = false
  }

  // ---------- lifecycle ----------

  /** Get (loading if needed) the live doc for a room and take a reference to it. */
  async acquire(roomName) {
    if (this.closed) throw new Error('Collab manager is shut down')
    let entry = this.entries.get(roomName)
    if (!entry) {
      let p = this.loading.get(roomName)
      if (!p) {
        p = this.#load(roomName).finally(() => this.loading.delete(roomName))
        this.loading.set(roomName, p)
      }
      entry = await p
    }
    entry.refs++
    clearTimeout(entry.unloadTimer)
    entry.unloadTimer = null
    return entry
  }

  /** Drop a reference. When the last one goes: persist immediately, snapshot, free the doc after a grace period. */
  release(entry) {
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs > 0 || entry.destroyed) return
    this.#enqueue(entry, async () => {
      await this.#flushNow(entry)
      if (entry.refs === 0) await this.#compact(entry)
    })
    clearTimeout(entry.unloadTimer)
    entry.unloadTimer = setTimeout(() => this.#unload(entry), this.unloadGraceMs)
    entry.unloadTimer.unref?.()
  }

  loadedRooms() {
    return [...this.entries.keys()]
  }

  get(roomName) {
    return this.entries.get(roomName)
  }

  async shutdown() {
    this.closed = true
    await Promise.allSettled([...this.loading.values()])
    for (const entry of this.entries.values()) {
      clearTimeout(entry.flushTimer)
      clearTimeout(entry.unloadTimer)
      await this.#enqueue(entry, async () => {
        await this.#flushNow(entry)
        await this.#compact(entry)
      })
      this.#destroy(entry)
    }
    this.entries.clear()
  }

  // ---------- connections (the WebSocket layer calls these) ----------

  attachConnection(entry, ws) {
    entry.conns.add(ws)
    ws.awarenessIds = new Set()
  }

  detachConnection(entry, ws) {
    if (!entry.conns.delete(ws)) return
    if (ws.awarenessIds?.size) awarenessProtocol.removeAwarenessStates(entry.awareness, [...ws.awarenessIds], null)
  }

  /**
   * Validate and apply an update from a client. Throws CollabError (caller closes the socket).
   * Pre-checks size limits *before* applying, since an applied Yjs update cannot be undone.
   */
  applyClientUpdate(entry, update, origin) {
    if (update.byteLength > this.maxUpdateBytes) throw new CollabError('TOO_LARGE', 'Update too large')
    try {
      Y.decodeUpdate(update) // structural validation without touching the doc
    } catch {
      throw new CollabError('MALFORMED', 'Malformed update')
    }
    if (entry.sizeEstimate + update.byteLength > this.maxDocBytes) {
      entry.sizeEstimate = Y.encodeStateAsUpdate(entry.doc).byteLength // rare: measure for real
      if (entry.sizeEstimate + update.byteLength > this.maxDocBytes) throw new CollabError('TOO_LARGE', 'Document too large')
    }
    // Inserted text can never exceed the update's UTF-8 byte length, so this cheap test is sufficient;
    // only near the limit do we pay for an exact check on a scratch copy.
    if (entry.ytext.length + update.byteLength > this.maxContentLength) {
      const scratch = new Y.Doc()
      try {
        Y.applyUpdate(scratch, Y.encodeStateAsUpdate(entry.doc))
        Y.applyUpdate(scratch, update)
        if (scratch.getText('content').length > this.maxContentLength) throw new CollabError('TOO_LARGE', 'Document too large')
      } finally {
        scratch.destroy()
      }
    }
    try {
      Y.applyUpdate(entry.doc, update, origin)
    } catch {
      throw new CollabError('MALFORMED', 'Update could not be applied')
    }
  }

  // ---------- REST bridge ----------

  /** Flush the live doc (if loaded) so the DB mirror is current. */
  async flushRoom(roomName) {
    const entry = this.entries.get(roomName)
    if (entry) await this.#enqueue(entry, () => this.#flushNow(entry))
  }

  /**
   * Apply REST-style `{content, language}` to the live document as a *minimal diff*, so it merges with
   * concurrent collaborative edits and is broadcast to connected clients instead of clobbering them.
   */
  async applyRest(roomName, { content, language }) {
    const entry = await this.acquire(roomName)
    try {
      entry.doc.transact(() => {
        if (content !== undefined) applyTextDiff(entry.ytext, content)
        if (language !== undefined) entry.meta.set('language', language)
      }, 'rest')
      await this.#enqueue(entry, () => this.#flushNow(entry))
    } finally {
      this.release(entry)
    }
  }

  // ---------- internals ----------

  async #load(roomName, attempt = 0) {
    if (this.storageGuard && !(await Room.exists({ roomName }))) {
      // Opening a room that does not exist would create it. Existing rooms are never affected by the guard.
      if (!(await this.storageGuard.status()).allowNewRooms) throw new StorageFullError()
    }
    try {
      await Room.updateOne(
        { roomName },
        { $setOnInsert: { roomName, content: '', language: 'plaintext' } },
        { upsert: true },
      )
    } catch (err) {
      if (err?.code !== 11000) throw err // lost the upsert race: the room exists, carry on
    }
    const room = await Room.findOne({ roomName }).select('+yjsState')
    const logged = await RoomUpdate.find({ roomName }).sort({ _id: 1 })

    const doc = new Y.Doc()
    const ytext = doc.getText('content')
    const meta = doc.getMap('meta')
    if (room.yjsState) Y.applyUpdate(doc, new Uint8Array(room.yjsState))
    for (const u of logged) Y.applyUpdate(doc, new Uint8Array(u.update))

    if (!room.yjsState && logged.length === 0) {
      // Phase 2 room (or brand-new room): initialise Yjs from the stored plain text, then snapshot at once so
      // every later load starts from the same state.
      doc.transact(() => {
        if (room.content) ytext.insert(0, room.content)
        meta.set('language', LANGUAGES.includes(room.language) ? room.language : 'plaintext')
      }, 'migration')
      // Claim the migration atomically: if another server instance (e.g. the old one during a rolling deploy)
      // initialised this room first, use ITS state. Two independent inserts of the same text would duplicate it.
      const claimed = await Room.updateOne(
        { roomName, yjsState: null }, // matches null or missing
        { $set: { yjsState: Buffer.from(Y.encodeStateAsUpdate(doc)), yjsUpdatedAt: new Date() }, $inc: { yjsRev: 1 } },
      )
      if (claimed.modifiedCount === 0 && attempt < 3) {
        doc.destroy()
        return this.#load(roomName, attempt + 1)
      }
      this.log(`initialised Yjs state for room "${roomName}" from existing content`)
    }

    const entry = {
      roomName, doc, ytext, meta,
      awareness: new awarenessProtocol.Awareness(doc),
      conns: new Set(), refs: 0, pending: [], chain: Promise.resolve(),
      flushTimer: null, unloadTimer: null, destroyed: false,
      updatesSinceSnapshot: logged.length,
      // Log entries this instance has merged into its doc. Compaction deletes ONLY these, never entries that
      // another instance wrote and this one has not seen.
      knownLogIds: logged.map((u) => u._id),
      sizeEstimate: 0, persistedSV: null,
    }
    entry.awareness.setLocalState(null) // the server itself is not a participant

    entry.sizeEstimate = Y.encodeStateAsUpdate(doc).byteLength
    entry.persistedSV = Y.encodeStateVector(doc)

    doc.on('update', (update, origin) => {
      entry.pending.push(update)
      entry.sizeEstimate += update.byteLength
      const msg = encodeSyncUpdate(update)
      for (const ws of entry.conns) if (ws !== origin) send(ws, msg)
      this.#scheduleFlush(entry)
    })
    entry.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      if (origin && entry.conns.has(origin)) {
        for (const id of added) origin.awarenessIds.add(id)
        for (const id of removed) origin.awarenessIds.delete(id)
      }
      const msg = encodeAwareness(entry.awareness, changed)
      for (const ws of entry.conns) send(ws, msg)
    })

    this.entries.set(roomName, entry)
    return entry
  }

  #enqueue(entry, fn) {
    entry.chain = entry.chain.then(fn).catch((err) => this.log(`persist error for "${entry.roomName}": ${err.name}`))
    return entry.chain
  }

  #scheduleFlush(entry, delay = this.flushIntervalMs) {
    if (entry.flushTimer || entry.destroyed) return
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null
      this.#enqueue(entry, () => this.#flushNow(entry))
    }, delay)
    entry.flushTimer.unref?.()
  }

  /** Write pending updates as ONE log entry and refresh the plain-text mirror. Must run inside the chain. */
  async #flushNow(entry) {
    clearTimeout(entry.flushTimer)
    entry.flushTimer = null
    if (entry.pending.length === 0) return
    const batch = entry.pending
    entry.pending = []
    const sv = Y.encodeStateVector(entry.doc)
    try {
      const logged = await RoomUpdate.create({ roomName: entry.roomName, update: Buffer.from(Y.mergeUpdates(batch)) })
      await Room.updateOne(
        { roomName: entry.roomName },
        { $set: { content: entry.ytext.toString(), language: languageOf(entry), yjsUpdatedAt: new Date() } },
      )
      entry.knownLogIds.push(logged._id)
      entry.updatesSinceSnapshot++
    } catch (err) {
      entry.pending = batch.concat(entry.pending) // keep it; nothing is lost
      this.log(`flush failed for "${entry.roomName}" (${err.name}); retrying`)
      if (!this.closed) this.#scheduleFlush(entry, 2000)
      return
    }
    entry.persistedSV = sv
    const ack = encodePersistedVector(sv)
    for (const ws of entry.conns) if (ws.wantsAck) send(ws, ack)
    if (entry.updatesSinceSnapshot >= this.compactEvery) await this.#compact(entry)
  }

  /** Fold everything into a snapshot, then drop the log entries it covers (snapshot first: crash-safe). */
  async #compact(entry) {
    if (entry.pending.length) await this.#flushNow(entry)
    if (entry.pending.length || entry.updatesSinceSnapshot === 0) return
    const state = Y.encodeStateAsUpdate(entry.doc) // superset of everything THIS instance has merged
    const mergedIds = entry.knownLogIds.slice()
    try {
      // Another server instance may be compacting the same room (rolling deploys overlap old and new instances).
      // So the snapshot is the UNION of what is stored and what we have (Yjs merges are idempotent), written with
      // compare-and-set on a revision counter; a lost race re-reads and retries. It can never replace a newer
      // snapshot with an older one.
      let written = false
      for (let attempt = 0; attempt < 4 && !written; attempt++) {
        const current = await Room.findOne({ roomName: entry.roomName }).select('+yjsState yjsRev')
        const rev = current?.yjsRev ?? 0
        const merged = current?.yjsState ? Y.mergeUpdates([new Uint8Array(current.yjsState), state]) : state
        const revMatches = rev === 0 ? [{ yjsRev: 0 }, { yjsRev: { $exists: false } }] : [{ yjsRev: rev }]
        const res = await Room.updateOne(
          { roomName: entry.roomName, $or: revMatches },
          { $set: { yjsState: Buffer.from(merged), yjsUpdatedAt: new Date() }, $inc: { yjsRev: 1 } },
        )
        written = res.modifiedCount === 1
      }
      if (!written) throw new Error('snapshot contention')
      // Only after the snapshot is safely stored: drop the log entries it is known to contain, and nothing else.
      if (mergedIds.length) await RoomUpdate.deleteMany({ roomName: entry.roomName, _id: { $in: mergedIds } })
      entry.knownLogIds = entry.knownLogIds.filter((id) => !mergedIds.some((m) => m.equals(id)))
      entry.updatesSinceSnapshot = 0
      entry.sizeEstimate = state.byteLength
    } catch (err) {
      this.log(`compaction failed for "${entry.roomName}" (${err.name}); will retry later`)
    }
  }

  #unload(entry) {
    if (entry.refs > 0 || entry.destroyed) return
    this.#enqueue(entry, async () => {
      if (entry.refs > 0) return
      await this.#flushNow(entry)
      if (entry.pending.length) return // persistence failing: keep the doc in memory and keep retrying
      this.entries.delete(entry.roomName)
      this.#destroy(entry)
    })
  }

  #destroy(entry) {
    entry.destroyed = true
    clearTimeout(entry.flushTimer)
    clearTimeout(entry.unloadTimer)
    entry.awareness.destroy()
    entry.doc.destroy()
  }
}

function languageOf(entry) {
  const l = entry.meta.get('language')
  return typeof l === 'string' && LANGUAGES.includes(l) ? l : 'plaintext'
}

/** Replace the text with `next` using the smallest single splice (common prefix/suffix). */
export function applyTextDiff(ytext, next) {
  const prev = ytext.toString()
  if (prev === next) return
  let start = 0
  const max = Math.min(prev.length, next.length)
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start-- // don't split a surrogate pair
  let endPrev = prev.length
  let endNext = next.length
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--
    endNext--
  }
  if (endPrev < prev.length && isLowSurrogate(prev.charCodeAt(endPrev))) {
    endPrev++
    endNext++
  }
  if (endPrev > start) ytext.delete(start, endPrev - start)
  if (endNext > start) ytext.insert(start, next.slice(start, endNext))
}

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff
