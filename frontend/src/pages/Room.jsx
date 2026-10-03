import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Logo from '../components/Logo.jsx'
import Editor from '../components/Editor.jsx'
import StatusPill from '../components/StatusPill.jsx'
import Toast, { useToast } from '../components/Toast.jsx'
import { LANGUAGES, labelFor } from '../lib/languages.js'
import { ROOM_CONTENT_MAX, roomUrl, validateRoomName } from '../lib/room.js'
import { useCollab } from '../lib/useCollab.js'
import { WAKE_MESSAGE } from '../lib/wake.js'

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

function Btn({ children, onClick, title, variant = 'default', className = '' }) {
  const styles =
    variant === 'primary'
      ? 'bg-mint text-ink hover:bg-mint-dim font-semibold border-transparent'
      : variant === 'danger'
        ? 'border-red-400/60 bg-red-400/10 text-red-200 hover:bg-red-400/20'
        : 'border-line bg-panel-2 text-fg hover:border-mint/60'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

function InvalidRoom({ name, problem }) {
  return (
    <div className="bg-glow flex min-h-full flex-col items-center justify-center gap-4 px-5 text-center">
      <Logo />
      <h1 className="text-2xl font-semibold">That room name isn’t valid</h1>
      <p className="max-w-md text-muted">
        “{name}” — {problem}
      </p>
      <Link to="/" className="rounded-lg bg-mint px-5 py-2.5 font-semibold text-ink hover:bg-mint-dim">
        Pick another room
      </Link>
    </div>
  )
}

export default function Room() {
  const { roomName = '' } = useParams()
  const problem = validateRoomName(roomName)
  if (problem) return <InvalidRoom name={roomName} problem={problem} />
  return <RoomView key={roomName} roomName={roomName} />
}

const PHASE_PILL = {
  connecting: { status: 'connecting', label: 'Connecting…' },
  connected: { status: 'connected', label: 'Connected' },
  disconnected: { status: 'error', label: 'Disconnected' },
  reconnecting: { status: 'connecting', label: 'Reconnecting…' },
  closed: { status: 'error', label: 'Disconnected' },
}

function RoomView({ roomName }) {
  const editor = useRef(null)
  const clearTimer = useRef(null)
  const [toast, showToast] = useToast()
  const { collab, phase, synced, persisted, language, peers, closeMessage, waitedForSync, everConnected, wakeTimedOut, reconnect, setRoomLanguage } =
    useCollab(roomName)
  const [stats, setStats] = useState({ chars: 0, lines: 1, line: 1, col: 1 })
  const [confirmClear, setConfirmClear] = useState(false)
  const url = roomUrl(roomName)

  useEffect(() => {
    document.title = `${roomName} · DropDrop`
    return () => {
      document.title = 'DropDrop – Drop it. Share it. Sync it.'
      clearTimeout(clearTimer.current)
    }
  }, [roomName])

  const handleChange = useCallback((doc) => {
    setStats((s) => ({ ...s, chars: doc.length, lines: doc.lines }))
  }, [])

  const handleSelection = useCallback((sel, doc) => {
    const line = doc.lineAt(sel.head)
    setStats((s) => ({ ...s, line: line.number, col: sel.head - line.from + 1 }))
  }, [])

  const handleLimit = useCallback(
    () => showToast(`Room limit reached (${ROOM_CONTENT_MAX.toLocaleString()} characters)`),
    [showToast],
  )

  async function copy() {
    const text = editor.current.getText()
    if (!text) return showToast('Nothing to copy yet')
    showToast((await copyToClipboard(text)) ? 'Copied to clipboard' : 'Copy failed — use Ctrl+C')
  }

  async function share() {
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: `DropDrop: ${roomName}`, url })
        return
      } catch (e) {
        if (e?.name === 'AbortError') return
      }
    }
    showToast((await copyToClipboard(url)) ? 'Room link copied' : 'Copy failed — copy the URL from the bar')
  }

  function clear() {
    if (!confirmClear) {
      setConfirmClear(true)
      clearTimeout(clearTimer.current)
      clearTimer.current = setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    clearTimeout(clearTimer.current)
    setConfirmClear(false)
    editor.current.clear()
    editor.current.focus()
    showToast('Room cleared')
  }

  // ---- derived UI state (only claims what is actually true) ----
  const pill = PHASE_PILL[phase]
  const online = phase === 'connected' && synced ? peers : null
  const saveLabel =
    phase === 'connected'
      ? persisted
        ? '✓ Saved'
        : 'Saving…'
      : persisted
        ? 'Offline'
        : 'Unsynced — kept in this tab'
  const saveColor = phase === 'connected' && persisted ? 'text-muted' : persisted ? 'text-muted' : 'text-amber-300'
  const showSyncing = !!collab && !synced && !waitedForSync && phase !== 'closed'
  // Never connected yet = a sleeping free-tier server is probably waking up; connected before = the connection was lost.
  const notConnected = phase === 'disconnected' || phase === 'reconnecting' || (phase === 'connecting' && waitedForSync)
  const waking = !everConnected && phase !== 'closed' && notConnected
  const connectionLost = everConnected && notConnected

  return (
    <div className="flex h-full flex-col bg-ink">
      <header className="border-b border-line bg-panel/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
          <Logo size={24} />
          <span className="hidden h-5 w-px bg-line sm:block" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-mono text-sm sm:text-base" title={roomName}>
              <span className="text-muted">/</span>
              {roomName}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              status={pill.status}
              label={pill.label}
              title={phase === 'connected' ? 'Live connection to the DropDrop server' : 'No live connection to the server right now'}
            />
            {online && (
              <span
                data-testid="presence"
                title={online.map((p) => `${p.name}${p.isSelf ? ' (you)' : ''}`).join('\n')}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21a8 8 0 0 1 16 0" />
                </svg>
                {online.length} online
              </span>
            )}
            <span
              aria-live="polite"
              title="Changes are stored on the server within about a second of typing"
              className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-xs ${saveColor}`}
            >
              {saveLabel}
            </span>
          </div>
        </div>

        {phase === 'closed' && (
          <div role="alert" className="border-t border-red-400/30 bg-red-400/10 px-4 py-2 text-center text-sm text-red-200">
            {closeMessage}{' '}
            <button type="button" onClick={reconnect} className="font-medium underline underline-offset-2">
              Reconnect
            </button>
          </div>
        )}
        {waking && !wakeTimedOut && (
          <div role="status" className="flex items-center justify-center gap-2.5 border-t border-amber-400/30 bg-amber-400/10 px-4 py-2 text-center text-sm text-amber-100">
            <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-amber-200/30 border-t-amber-200" />
            {WAKE_MESSAGE}
          </div>
        )}
        {waking && wakeTimedOut && (
          <div role="alert" className="border-t border-red-400/30 bg-red-400/10 px-4 py-2 text-center text-sm text-red-200">
            The DropDrop server didn’t respond. It may be down, or your connection may be offline.{' '}
            <button type="button" onClick={reconnect} className="font-medium underline underline-offset-2">
              Try again
            </button>
          </div>
        )}
        {connectionLost && (
          <div role="status" className="border-t border-amber-400/30 bg-amber-400/10 px-4 py-2 text-center text-sm text-amber-100">
            Can’t reach the DropDrop server. Your edits are kept in this tab and will sync automatically when the connection returns.
          </div>
        )}

        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 pb-3">
          <Btn onClick={copy} title="Copy all text">
            Copy
          </Btn>
          <Btn onClick={() => editor.current.selectAll()} title="Select all text (Ctrl+A)">
            Select all
          </Btn>
          <Btn onClick={clear} variant={confirmClear ? 'danger' : 'default'} title="Remove all text from this room (for everyone)">
            {confirmClear ? 'Click again to confirm' : 'Clear'}
          </Btn>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label htmlFor="lang" className="sr-only">
              Language
            </label>
            <select
              id="lang"
              value={language}
              onChange={(e) => setRoomLanguage(e.target.value)}
              className="rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-fg outline-none focus:border-mint"
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <Btn onClick={share} variant="primary" title={url}>
              Share room
            </Btn>
          </div>
        </div>
      </header>

      <main className="mx-auto min-h-0 w-full max-w-6xl flex-1 px-0 sm:px-4 sm:py-4">
        <div className="relative h-full overflow-hidden border-y border-line bg-panel sm:rounded-xl sm:border">
          {collab && (
            <Editor
              ref={editor}
              ytext={collab.ytext}
              awareness={collab.awareness}
              language={labelFor(language)}
              onChange={handleChange}
              onSelectionChange={handleSelection}
              onLimit={handleLimit}
            />
          )}
          {showSyncing && (
            <div
              role="status"
              className="pointer-events-none absolute inset-0 flex items-center justify-center gap-3 bg-panel/70 text-muted"
            >
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-mint" />
              Loading <span className="font-mono text-fg">/{roomName}</span>…
            </div>
          )}
        </div>
      </main>

      <footer className="border-t border-line bg-panel/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-xs text-muted">
          <span className="min-w-0 truncate font-mono" title={url}>
            {url}
          </span>
          <span className="font-mono">
            Ln {stats.line}, Col {stats.col} · {stats.lines} {stats.lines === 1 ? 'line' : 'lines'} ·{' '}
            {stats.chars.toLocaleString()} chars
          </span>
        </div>
      </footer>

      <Toast message={toast} />
    </div>
  )
}
