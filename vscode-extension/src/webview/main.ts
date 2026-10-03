import './webview.css'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness'
import { Compartment, EditorState, Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { defaultKeymap, indentWithTab, selectAll } from '@codemirror/commands'
import { StreamLanguage, bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { sql } from '@codemirror/lang-sql'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from 'y-codemirror.next'
import { fromBase64, toBase64 } from '../shared/codec'
import type { HostToWebview, WebviewToHost } from '../shared/messages'
import type { SessionState } from '../services/collaborationService'

declare function acquireVsCodeApi(): { postMessage(m: WebviewToHost): void }
const vscode = acquireVsCodeApi()
const post = (m: WebviewToHost) => vscode.postMessage(m)
const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content

const LANG: Record<string, () => Extension> = {
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  python: () => python(),
  json: () => json(),
  html: () => html(),
  css: () => css(),
  markdown: () => markdown(),
  sql: () => sql(),
  java: () => java(),
  cpp: () => cpp(),
  go: () => go(),
  rust: () => rust(),
  shell: () => StreamLanguage.define(shell),
}

// ---------- static UI (built with textContent only: peer names are untrusted input) ----------
const app = document.getElementById('app')!
app.innerHTML = `
<header class="bar">
  <div class="title"><span class="room" id="room"></span></div>
  <div class="pills">
    <span class="pill" id="conn"><span class="dot"></span><span id="connText">Connecting…</span></span>
    <span class="pill" id="presence" hidden></span>
    <span class="pill" id="saved"></span>
  </div>
</header>
<div class="banner err" id="closedBanner" role="alert" hidden><span id="closedText"></span> <button class="link" id="reconnect">Reconnect</button></div>
<div class="banner warn" id="offlineBanner" role="status" hidden>Can’t reach the DropDrop server. Your edits are kept here and will sync automatically when the connection returns.</div>
<div class="toolbar">
  <button id="copy" title="Copy all text">Copy</button>
  <button id="selectAll" title="Select all (Ctrl/Cmd+A)">Select all</button>
  <button id="clear" title="Remove all text from this room (for everyone)">Clear</button>
  <span class="spacer"></span>
  <label class="sr" for="lang">Language</label>
  <select id="lang"></select>
  <button id="share" class="primary" title="Copy the website link for this room">Share link</button>
  <button id="leave" title="Disconnect; the document stays saved on the server">Leave</button>
</div>
<main class="editor"><div id="cm"></div><div class="loading" id="loading">Loading room…</div></main>
<footer class="foot"><span id="warn">Anyone who knows this room name can read and edit it.</span><span id="stats"></span></footer>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

// ---------- session ----------
interface Ctx {
  doc: Y.Doc
  awareness: Awareness
  ytext: Y.Text
  view: EditorView
  limit: number
}
let ctx: Ctx | null = null
let langId = 'plaintext'
let status: SessionState | null = null
const langCompartment = new Compartment()
const themeCompartment = new Compartment()

function themeExtension(): Extension {
  const dark = !document.body.classList.contains('vscode-light')
  return dark
    ? oneDark
    : [syntaxHighlighting(defaultHighlightStyle, { fallback: true }), EditorView.theme({ '&': { backgroundColor: 'transparent' } }, { dark: false })]
}
const transparent = EditorView.theme({ '&': { backgroundColor: 'transparent' } })
const langExtension = (id: string): Extension => (LANG[id] ? LANG[id]() : [])

function teardown(): void {
  if (!ctx) return
  ctx.view.destroy()
  ctx.awareness.destroy()
  ctx.doc.destroy()
  ctx = null
}

function init(msg: Extract<HostToWebview, { type: 'init' }>): void {
  teardown()
  const doc = new Y.Doc()
  // The host owns the connection; this doc is a replica with its OWN client id (Yjs would rename a doc whose
  // client id another writer reuses). The host publishes our cursor state under the window's identity, so the
  // server still sees exactly one participant per VS Code window.
  Y.applyUpdate(doc, fromBase64(msg.state), 'host')
  const ytext = doc.getText('content')
  const awareness = new Awareness(doc)
  awareness.setLocalState({ user: msg.identity })
  if (msg.awareness) applyAwarenessUpdate(awareness, fromBase64(msg.awareness), 'host')

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'host') post({ type: 'update', update: toBase64(update) })
  })
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === 'host') return
    if (added.concat(updated, removed).includes(doc.clientID)) post({ type: 'localState', state: awareness.getLocalState() as Record<string, unknown> | null })
  })

  const limit = msg.contentLimit
  const view = new EditorView({
    parent: $('cm'),
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        EditorView.lineWrapping,
        placeholder('Start typing, or paste something to share…'),
        // yCollab handles native undo events only; redo (Ctrl+Y, Cmd+Shift+Z) needs this keymap.
        keymap.of([...yUndoManagerKeymap, indentWithTab, ...defaultKeymap]),
        yCollab(ytext, awareness), // Yjs-aware undo/redo (Ctrl/Cmd+Z, Ctrl+Y, Ctrl/Cmd+Shift+Z) and remote cursors
        EditorState.changeFilter.of((tr) => {
          if (tr.annotation(ySyncAnnotation) || tr.newDoc.length <= limit) return true
          toast(`Room limit reached (${limit.toLocaleString()} characters)`)
          return false
        }),
        themeCompartment.of(themeExtension()),
        transparent,
        langCompartment.of(langExtension(langId)),
        ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged || u.selectionSet) {
            const head = u.state.selection.main.head
            const line = u.state.doc.lineAt(head)
            $('stats').textContent = `Ln ${line.number}, Col ${head - line.from + 1} · ${u.state.doc.lines} ${u.state.doc.lines === 1 ? 'line' : 'lines'} · ${u.state.doc.length.toLocaleString()} chars`
          }
        }),
      ],
    }),
  })
  ctx = { doc, awareness, ytext, view, limit }

  $('room').textContent = `/${msg.roomName}`
  const lang = $<HTMLSelectElement>('lang')
  lang.replaceChildren(...msg.languages.map((l) => Object.assign(document.createElement('option'), { value: l.id, textContent: l.label })))
  $('share').hidden = !msg.publicLink
  render(msg.status)
  view.focus()
}

function render(s: SessionState): void {
  status = s
  const labels: Record<SessionState['phase'], string> = {
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnected: 'Disconnected',
    reconnecting: 'Reconnecting…',
    closed: 'Disconnected',
  }
  $('connText').textContent = labels[s.phase]
  $('conn').className = `pill ${s.phase === 'connected' ? 'ok' : s.phase === 'connecting' || s.phase === 'reconnecting' ? 'busy' : 'bad'}`

  // Presence is shown only when it is real: connected and synced with the server.
  const online = s.phase === 'connected' && s.synced ? s.peers : null
  const pres = $('presence')
  pres.hidden = !online
  if (online) {
    pres.textContent = `${online.length} online`
    pres.title = online.map((p) => `${p.name}${p.isSelf ? ' (you)' : ''}`).join('\n')
  }
  const saved = $('saved')
  saved.textContent = s.phase === 'connected' ? (s.persisted ? '✓ Saved' : 'Saving…') : s.persisted ? 'Offline' : 'Unsynced: kept here'
  saved.className = `pill ${s.persisted ? '' : 'busy'}`

  $('closedBanner').hidden = s.phase !== 'closed'
  $('closedText').textContent = s.closeMessage ?? ''
  $('offlineBanner').hidden = !(s.phase === 'disconnected' || s.phase === 'reconnecting')
  $('loading').hidden = s.synced || s.phase === 'closed' || s.phase === 'disconnected' || s.phase === 'reconnecting'

  langId = s.language
  const select = $<HTMLSelectElement>('lang')
  if (select.value !== langId) select.value = langId
  ctx?.view.dispatch({ effects: langCompartment.reconfigure(langExtension(langId)) })
}

let toastTimer: number | undefined
function toast(text: string): void {
  const t = $('toast')
  t.textContent = text
  t.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2200)
}

// ---------- toolbar ----------
$('copy').addEventListener('click', () => {
  const text = ctx?.ytext.toString() ?? ''
  if (!text) return toast('Nothing to copy yet')
  post({ type: 'copyText', text })
})
$('selectAll').addEventListener('click', () => {
  if (!ctx) return
  ctx.view.focus()
  selectAll(ctx.view)
})
let clearTimer: number | undefined
$('clear').addEventListener('click', () => {
  const btn = $('clear')
  if (!ctx) return
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger')
    btn.textContent = 'Click again to confirm'
    clearTimer = window.setTimeout(resetClear, 3000)
    return
  }
  resetClear()
  ctx.view.dispatch({ changes: { from: 0, to: ctx.view.state.doc.length, insert: '' } })
  ctx.view.focus()
  toast('Room cleared')
})
function resetClear(): void {
  window.clearTimeout(clearTimer)
  $('clear').classList.remove('danger')
  $('clear').textContent = 'Clear'
}
$<HTMLSelectElement>('lang').addEventListener('change', (e) => post({ type: 'setLanguage', language: (e.target as HTMLSelectElement).value }))
$('share').addEventListener('click', () => post({ type: 'copyLink' }))
$('leave').addEventListener('click', () => post({ type: 'leave' }))
$('reconnect').addEventListener('click', () => post({ type: 'reconnect' }))

// Follow VS Code theme changes (dark/light) live.
new MutationObserver(() => ctx?.view.dispatch({ effects: themeCompartment.reconfigure(themeExtension()) })).observe(document.body, {
  attributes: true,
  attributeFilter: ['class'],
})

// ---------- host messages ----------
window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const m = e.data
  if (!m || typeof m.type !== 'string') return
  switch (m.type) {
    case 'init':
      init(m)
      break
    case 'update':
      if (ctx) Y.applyUpdate(ctx.doc, fromBase64(m.update), 'host')
      break
    case 'awareness':
      if (ctx) applyAwarenessUpdate(ctx.awareness, fromBase64(m.update), 'host')
      break
    case 'status':
      render(m.status)
      break
    case 'toast':
      toast(m.text)
      break
  }
})

post({ type: 'ready' })
void status
