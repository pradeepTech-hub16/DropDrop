// Relays Yjs updates and awareness between the host-owned CollaborationSession and the editor webview.
// No vscode dependency, so the exact same code is exercised by the browser-based cross-platform tests.
import { fromBase64, toBase64 } from '../shared/codec'
import type { HostToWebview, WebviewToHost } from '../shared/messages'
import { LANGUAGES, ROOM_CONTENT_MAX } from '../utils/validation'
import { CollaborationSession, WEBVIEW_ORIGIN } from './collaborationService'

const MAX_UPDATE_BASE64 = 2 * 1024 * 1024 // generous: server rejects updates over 1 MB (raw) anyway
const MAX_AWARENESS_JSON = 4096

export interface RelayActions {
  copyText(text: string): void
  copyLink(): void
  reconnect(): void
  leave(): void
}

export class WebviewRelay {
  private unbind: (() => void) | undefined

  constructor(
    readonly session: CollaborationSession,
    private readonly post: (message: HostToWebview) => void,
    private readonly actions: RelayActions,
    private readonly getPublicLink: () => string | null = () => null,
  ) {}

  /** (Re)initialise the webview with the full current document, and start forwarding changes. */
  sendInit(): void {
    this.bind()
    const awareness = this.session.encodeRemoteAwareness()
    this.post({
      type: 'init',
      roomName: this.session.roomName,
      state: toBase64(this.session.encodeState()),
      awareness: awareness ? toBase64(awareness) : null,
      identity: this.session.identity,
      status: this.session.state,
      languages: LANGUAGES,
      contentLimit: ROOM_CONTENT_MAX,
      publicLink: this.getPublicLink(),
    })
  }

  /** Handles a message from the webview. Everything is validated; malformed messages are ignored. */
  handle(raw: unknown): void {
    const m = raw as WebviewToHost
    if (!m || typeof m !== 'object' || typeof (m as { type?: unknown }).type !== 'string') return
    try {
      switch (m.type) {
        case 'ready':
          this.sendInit()
          break
        case 'update':
          if (typeof m.update === 'string' && m.update.length <= MAX_UPDATE_BASE64) {
            this.session.applyWebviewUpdate(fromBase64(m.update))
          }
          break
        case 'localState': {
          const s = m.state
          if (s === null || (typeof s === 'object' && JSON.stringify(s).length <= MAX_AWARENESS_JSON)) {
            this.session.setLocalAwareness(s)
          }
          break
        }
        case 'setLanguage':
          if (typeof m.language === 'string') this.session.setLanguage(m.language)
          break
        case 'copyText':
          if (typeof m.text === 'string') this.actions.copyText(m.text)
          break
        case 'copyLink':
          this.actions.copyLink()
          break
        case 'reconnect':
          this.actions.reconnect()
          break
        case 'leave':
          this.actions.leave()
          break
      }
    } catch (err) {
      // Never log document contents; the error class is enough.
      console.error('[dropdrop] webview message rejected:', err instanceof Error ? err.name : 'error')
    }
  }

  dispose(): void {
    this.unbind?.()
    this.unbind = undefined
  }

  private bind(): void {
    this.unbind?.()
    const s = this.session
    const onDoc = (update: Uint8Array, origin: unknown) => {
      if (origin !== WEBVIEW_ORIGIN) this.post({ type: 'update', update: toBase64(update) })
    }
    const onAwareness = (update: Uint8Array) => this.post({ type: 'awareness', update: toBase64(update) })
    const onState = () => this.post({ type: 'status', status: s.state })
    s.on('doc-update', onDoc)
    s.on('awareness-update', onAwareness)
    s.on('state', onState)
    this.unbind = () => {
      s.off('doc-update', onDoc)
      s.off('awareness-update', onAwareness)
      s.off('state', onState)
    }
  }
}
