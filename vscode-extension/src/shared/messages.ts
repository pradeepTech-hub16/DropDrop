// Messages exchanged between the extension host (which owns the WebSocket + Y.Doc) and the editor webview
// (which owns a CodeMirror editor bound to a *replica* of that Y.Doc). The webview never talks to the network:
// Yjs updates and awareness are relayed through the host, which is the only party connected to the server.
import type { SessionState } from '../services/collaborationService'
import type { LanguageOption } from '../utils/validation'

export interface Identity {
  name: string
  color: string
  colorLight: string
}

export type HostToWebview =
  | {
      type: 'init'
      roomName: string
      /** base64 Y.encodeStateAsUpdate of the host doc */
      state: string
      /** base64 awareness update for the other participants, if any */
      awareness: string | null
      identity: Identity
      status: SessionState
      languages: LanguageOption[]
      contentLimit: number
      publicLink: string | null
    }
  | { type: 'update'; update: string }
  | { type: 'awareness'; update: string }
  | { type: 'status'; status: SessionState }
  | { type: 'toast'; text: string }

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'update'; update: string }
  | { type: 'localState'; state: Record<string, unknown> | null }
  | { type: 'setLanguage'; language: string }
  | { type: 'copyText'; text: string }
  | { type: 'copyLink' }
  | { type: 'reconnect' }
  | { type: 'leave' }
