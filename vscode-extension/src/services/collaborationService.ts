// Real-time collaboration core. No vscode dependency: this exact code is what runs in the extension host,
// and it is tested against the real backend. All synchronisation goes through the DropDrop server
// (y-websocket protocol); nothing is synchronised locally between sessions.
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import WebSocket from 'ws'
import { Endpoints, ConfigError } from '../utils/urls'
import { LANGUAGES, validateRoomName } from '../utils/validation'
import { RoomService, WakeOptions } from './roomService'

export type Phase = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'closed'

export interface Peer {
  clientId: number
  name: string
  color: string
  isSelf: boolean
}

export interface SessionState {
  roomName: string
  phase: Phase
  /** True once the initial document sync with the server has completed on the current connection. */
  synced: boolean
  /** True when every local change is covered by the server's last persistence acknowledgement. */
  persisted: boolean
  language: string
  /** Real presence from Yjs awareness. Only meaningful when phase === 'connected' && synced. */
  peers: Peer[]
  /** Set when the server permanently refused the connection (close codes 4400-4499). */
  closeMessage: string | null
}

export const WEBVIEW_ORIGIN = 'webview'
const MSG_PERSISTED = 10 // DropDrop protocol extension (see backend/src/collab/protocol.js)

export const CLOSE_MESSAGES: Record<number, string> = {
  4400: 'This room name isn’t valid.',
  4401: 'The server rejected a message from this client. Leave and rejoin the room.',
  4403: 'The server doesn’t allow connections from this client (origin not allowed).',
  4409: 'DropDrop’s free storage is nearly full, so new rooms are temporarily disabled. Existing rooms keep working; try again later.',
  4413: 'This room reached its size limit, so new edits can’t be saved. Remove some text, then reconnect.',
  4429: 'Too many requests from this connection. Wait a moment, then reconnect.',
}

const ADJECTIVES = ['Swift', 'Calm', 'Bright', 'Quiet', 'Lucky', 'Brave', 'Witty', 'Mellow', 'Nimble', 'Sunny']
const ANIMALS = ['Fox', 'Otter', 'Heron', 'Lynx', 'Panda', 'Falcon', 'Gecko', 'Koala', 'Raven', 'Seal']
const COLORS = ['#3ddc97', '#4cc9f0', '#f72585', '#ffb703', '#b388ff', '#ff7f50', '#80ed99', '#ffd166']
const pick = <T>(l: T[]): T => l[Math.floor(Math.random() * l.length)]

export function anonymousIdentity() {
  const color = pick(COLORS)
  return { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color, colorLight: `${color}33` }
}

export interface SessionOptions {
  wsUrl: string
  roomName: string
  maxBackoffTime?: number
  identity?: { name: string; color: string; colorLight: string }
}

export declare interface CollaborationSession {
  on(event: 'state', listener: (state: SessionState) => void): this
  on(event: 'doc-update', listener: (update: Uint8Array, origin: unknown) => void): this
  on(event: 'awareness-update', listener: (update: Uint8Array) => void): this
}

/** One joined room: a Y.Doc bound to the server through y-websocket. */
export class CollaborationSession extends EventEmitter {
  readonly doc = new Y.Doc()
  readonly ytext = this.doc.getText('content')
  readonly meta = this.doc.getMap('meta')
  readonly provider: WebsocketProvider
  readonly identity: { name: string; color: string; colorLight: string }
  readonly roomName: string

  private persistedSV = new Map<number, number>()
  private everConnected = false
  private failures = 0
  private permanent = false
  private disposed = false
  private _state: SessionState

  constructor(opts: SessionOptions) {
    super()
    this.roomName = opts.roomName
    this.identity = opts.identity ?? anonymousIdentity()
    this.provider = new WebsocketProvider(opts.wsUrl, opts.roomName, this.doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      disableBc: true, // every change must go through the server
      params: { 'persisted-ack': '1' },
      maxBackoffTime: opts.maxBackoffTime ?? 5000,
    })
    this.provider.awareness.setLocalStateField('user', this.identity)
    this._state = this.computeState('connecting')

    this.provider.on('status', this.onStatus)
    this.provider.on('connection-close', this.onClose)
    this.provider.on('sync', this.onSync)
    this.meta.observe(this.onMeta)
    this.doc.on('update', this.onDocUpdate)
    this.provider.awareness.on('update', this.onAwarenessUpdate)
    this.provider.awareness.on('change', this.onAwarenessChange)
    this.provider.messageHandlers[MSG_PERSISTED] = (_enc, dec) => {
      this.persistedSV = Y.decodeStateVector(decoding.readVarUint8Array(dec))
      this.refresh()
    }
  }

  get state(): SessionState {
    return this._state
  }
  get clientId(): number {
    return this.doc.clientID
  }
  get text(): string {
    return this.ytext.toString()
  }
  get isDisposed(): boolean {
    return this.disposed
  }

  /** Full document state, for initialising a webview. */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc)
  }

  /** An update produced by the webview editor; applied to the shared doc (and therefore sent to the server). */
  applyWebviewUpdate(update: Uint8Array): void {
    if (!this.disposed) Y.applyUpdate(this.doc, update, WEBVIEW_ORIGIN)
  }

  setLanguage(id: string): void {
    if (this.disposed || !LANGUAGES.some((l) => l.id === id)) return
    this.meta.set('language', id)
  }

  /** The webview's cursor/selection state; our identity is always attached by us, never trusted from the webview. */
  setLocalAwareness(state: Record<string, unknown> | null): void {
    if (this.disposed) return
    this.provider.awareness.setLocalState(state ? { ...state, user: this.identity } : null)
  }

  /** Awareness update about every client except ourselves, for forwarding to the webview. */
  encodeRemoteAwareness(): Uint8Array | null {
    const ids = [...this.provider.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
    return ids.length ? awarenessProtocol.encodeAwarenessUpdate(this.provider.awareness, ids) : null
  }

  /** Tear down: closes the WebSocket, removes our presence, frees the Y.Doc. Idempotent. Server data is untouched. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.meta.unobserve(this.onMeta)
    this.doc.off('update', this.onDocUpdate)
    this.provider.awareness.off('update', this.onAwarenessUpdate)
    this.provider.awareness.off('change', this.onAwarenessChange)
    this.provider.awareness.setLocalState(null)
    this.provider.destroy()
    this.doc.destroy()
    this.removeAllListeners()
  }

  // ---- internals ----

  private isPersisted(): boolean {
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(this.doc))) {
      if ((this.persistedSV.get(client) ?? 0) < clock) return false
    }
    return true
  }

  private computeState(phase: Phase): SessionState {
    const peers: Peer[] = []
    this.provider.awareness.getStates().forEach((s, clientId) => {
      const u = (s as any).user
      if (u) peers.push({ clientId, name: String(u.name), color: String(u.color), isSelf: clientId === this.doc.clientID })
    })
    const lang = this.meta.get('language')
    return {
      roomName: this.roomName,
      phase,
      synced: this.provider.synced,
      persisted: this.isPersisted(),
      language: typeof lang === 'string' ? lang : 'plaintext',
      peers,
      closeMessage: this._state?.closeMessage ?? null,
    }
  }

  private refresh(phase: Phase = this._state.phase, closeMessage?: string | null): void {
    if (this.disposed) return
    const next = this.computeState(phase)
    if (closeMessage !== undefined) next.closeMessage = closeMessage
    const prev = this._state
    this._state = next
    if (
      prev.phase !== next.phase || prev.synced !== next.synced || prev.persisted !== next.persisted ||
      prev.language !== next.language || prev.closeMessage !== next.closeMessage ||
      JSON.stringify(prev.peers) !== JSON.stringify(next.peers)
    ) {
      this.emit('state', next)
    }
  }

  private onStatus = ({ status }: { status: 'connected' | 'connecting' | 'disconnected' }) => {
    if (this.permanent) return
    if (status === 'connected') {
      this.everConnected = true
      this.refresh('connected')
    } else if (status === 'connecting') {
      this.refresh(this.everConnected || this.failures > 0 ? 'reconnecting' : 'connecting')
    } else {
      this.failures++
      this.refresh('disconnected')
    }
  }

  private onClose = (event: { code?: number } | null) => {
    const code = event?.code
    if (code !== undefined && code >= 4400 && code <= 4499) {
      this.permanent = true
      this.refresh('closed', CLOSE_MESSAGES[code] ?? 'The server closed the connection.')
    }
  }

  private onSync = () => this.refresh()
  private onMeta = () => this.refresh()
  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    this.emit('doc-update', update, origin)
    this.refresh()
  }
  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = added.concat(updated, removed).filter((id) => id !== this.doc.clientID)
    if (changed.length && origin !== 'webview-forward') {
      this.emit('awareness-update', awarenessProtocol.encodeAwarenessUpdate(this.provider.awareness, changed))
    }
  }
  private onAwarenessChange = () => this.refresh()
}

export type JoinOptions = WakeOptions

export interface CollaborationServiceEvents {
  on(event: 'session', listener: (session: CollaborationSession | null) => void): this
  on(event: 'state', listener: (state: SessionState | null) => void): this
}

/** Manages the single active room: joining (REST open + WebSocket), leaving, rejoining. */
export class CollaborationService extends EventEmitter implements CollaborationServiceEvents {
  private _session: CollaborationSession | null = null
  private joinToken = 0
  private inflight: { room: string; promise: Promise<{ session: CollaborationSession; created: boolean }>; abort: () => void } | null = null
  private lastRoom: string | null = null

  constructor(
    /** Resolves current settings; throws ConfigError when they are invalid. Called on every join. */
    private readonly getEndpoints: () => Endpoints,
    private readonly sessionOptions: { maxBackoffTime?: number } = {},
  ) {
    super()
  }

  get session(): CollaborationSession | null {
    return this._session
  }
  get endpoints(): Endpoints {
    return this.getEndpoints()
  }

  /**
   * Joins (creating if new) a room. Validates the name with the website's exact rules.
   *
   * Cold starts: a free-tier server sleeps when idle. Before the (idempotent) create-or-get request, this waits up to
   * ~90 s for the read-only health check to succeed, calling `opts.onWaking` once if the server is slow to answer.
   * `opts.signal` cancels at any moment (rejects with an AbortError). Joining the same room twice at once shares one
   * attempt, so retries and double clicks never produce duplicate requests.
   */
  async join(roomName: string, opts: JoinOptions = {}): Promise<{ session: CollaborationSession; created: boolean }> {
    const problem = validateRoomName(roomName)
    if (problem) throw new RangeError(problem)

    if (this._session && !this._session.isDisposed && this._session.roomName === roomName) {
      return { session: this._session, created: false }
    }
    if (this.inflight?.room === roomName) return this.inflight.promise // same room already being joined
    this.inflight?.abort() // a different room was being joined: this request supersedes it

    const controller = new AbortController()
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    const promise = this.doJoin(roomName, { ...opts, signal: controller.signal }).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null
    })
    this.inflight = { room: roomName, promise, abort: () => controller.abort() }
    return promise
  }

  private async doJoin(roomName: string, opts: JoinOptions): Promise<{ session: CollaborationSession; created: boolean }> {
    const endpoints = this.getEndpoints() // may throw ConfigError
    const token = ++this.joinToken
    const rooms = new RoomService(endpoints.apiUrl)
    await rooms.waitUntilAwake(opts) // may throw ApiError / WakeTimeoutError / AbortError
    if (token !== this.joinToken) throw Object.assign(new Error('Join cancelled by a newer request.'), { name: 'AbortError' })
    const { created } = await rooms.openRoom(roomName, opts.signal) // may throw ApiError
    if (token !== this.joinToken) throw Object.assign(new Error('Join cancelled by a newer request.'), { name: 'AbortError' })

    this.leave()
    const session = new CollaborationSession({ wsUrl: endpoints.wsUrl, roomName, ...this.sessionOptions })
    session.on('state', (s) => this.emit('state', s))
    this._session = session
    this.lastRoom = roomName
    this.emit('session', session)
    this.emit('state', session.state)
    return { session, created }
  }

  /** Disconnects and frees the session. Server-side data is preserved. */
  leave(): void {
    this.joinToken++ // cancel any join in flight
    this.inflight?.abort()
    const s = this._session
    if (!s) return
    this._session = null
    s.dispose()
    this.emit('session', null)
    this.emit('state', null)
  }

  /** Tear down and re-join the current room (used after a permanent server refusal). */
  async rejoin(): Promise<void> {
    const room = this._session?.roomName ?? this.lastRoom
    if (!room) return
    this.leave()
    await this.join(room)
  }

  dispose(): void {
    this.leave()
    this.removeAllListeners()
  }
}

export { ConfigError }
