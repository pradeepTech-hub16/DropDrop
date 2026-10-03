import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Logo, { LogoMark } from '../components/Logo.jsx'
import { createRoom } from '../lib/api.js'
import { WAKE_MESSAGE, waitForServer } from '../lib/wake.js'
import { ROOM_NAME_MAX, randomRoomName, validateRoomName } from '../lib/room.js'

const STEPS = [
  { title: 'Pick a name', body: 'Type any room name, like team-notes or sprint-demo. No account needed.' },
  { title: 'Share the link', body: 'Anyone who opens the same room name sees the same content. Send them the URL.' },
  { title: 'Edit together', body: 'Everyone opens the same document, and you edit it together in real time and it is saved automatically.' },
]

export default function Home() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [waking, setWaking] = useState(false)
  const attempt = useRef(null) // AbortController of the request in progress (at most one at a time)

  useEffect(() => () => attempt.current?.abort(), []) // leaving the page cancels any pending request

  async function submit(e) {
    e.preventDefault()
    if (attempt.current) return // a double click must never start a second request
    const trimmed = name.trim()
    const problem = validateRoomName(trimmed)
    if (problem) return setError(problem)
    const controller = new AbortController()
    attempt.current = controller
    setBusy(true)
    setError(null)
    try {
      // A free-tier server sleeps when idle. Wait (read-only health checks, up to ~90 s) until it answers, THEN make
      // the single create-or-get request, so retries can never create duplicate rooms.
      await waitForServer({ signal: controller.signal, onWaking: () => setWaking(true) })
      await createRoom(trimmed, { signal: controller.signal }) // creates the room, or returns the existing one
      navigate(`/${encodeURIComponent(trimmed)}`)
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err.message) // AbortError = the user pressed Cancel
    } finally {
      attempt.current = null
      setBusy(false)
      setWaking(false)
    }
  }

  return (
    <div className="bg-glow flex min-h-full flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-5">
        <Logo />
        <span className="hidden text-sm text-muted sm:block">No login. No sign-up.</span>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-5 pb-16 pt-10 sm:pt-20">
        <LogoMark size={56} />
        <h1 className="mt-6 text-center text-4xl font-bold tracking-tight sm:text-6xl">
          Drop<span className="text-mint">Drop</span>
        </h1>
        <p className="mt-3 text-center text-lg font-medium text-mint sm:text-xl">Drop it. Share it. Sync it.</p>
        <p className="mt-5 max-w-xl text-center text-muted">
          A shared text workspace for notes, snippets and quick handoffs. Open a room, paste your text or code, and
          anyone with the room name can open and edit it.
        </p>

        <form onSubmit={submit} className="mt-10 w-full max-w-xl" noValidate>
          <label htmlFor="room" className="sr-only">
            Room name
          </label>
          <div
            className={`flex flex-col gap-2 rounded-xl border bg-panel p-2 shadow-xl shadow-black/20 transition-colors focus-within:border-mint sm:flex-row ${
              error ? 'border-red-400/70' : 'border-line'
            }`}
          >
            <div className="flex flex-1 items-center gap-1 px-3 font-mono text-sm text-muted">
              <span className="hidden shrink-0 select-none whitespace-nowrap sm:inline">dropdrop /</span>
              <input
                id="room"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={ROOM_NAME_MAX + 1}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setError(null)
                }}
                placeholder="your-room-name"
                aria-invalid={!!error}
                aria-describedby={error ? 'room-error' : undefined}
                className="w-full min-w-0 bg-transparent py-2.5 text-base text-fg outline-none placeholder:text-muted/60"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-mint px-5 py-2.5 font-semibold text-ink transition hover:bg-mint-dim disabled:cursor-wait disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint"
            >
              {busy ? 'Opening…' : 'Create / Join Room'}
            </button>
          </div>
          {waking && (
            <div role="status" className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-100">
              <span className="flex items-center gap-2.5">
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-amber-200/30 border-t-amber-200" />
                {WAKE_MESSAGE}
              </span>
              <button type="button" onClick={() => attempt.current?.abort()} className="shrink-0 font-medium underline underline-offset-2">
                Cancel
              </button>
            </div>
          )}
          {error && (
            <p id="room-error" role="alert" className="mt-2 px-1 text-sm text-red-300">
              {error}
            </p>
          )}
          <p className="mt-3 px-1 text-sm text-muted">
            Not sure?{' '}
            <button
              type="button"
              onClick={() => {
                setName(randomRoomName())
                setError(null)
              }}
              className="text-mint underline-offset-2 hover:underline"
            >
              Generate a random room name
            </button>
          </p>
        </form>

        <section className="mt-20 w-full" aria-labelledby="how">
          <h2 id="how" className="text-center text-sm font-semibold uppercase tracking-widest text-muted">
            How rooms work
          </h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-xl border border-line bg-panel p-5">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-mint/15 font-mono text-sm text-mint">
                  {i + 1}
                </span>
                <h3 className="mt-3 font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mx-auto mt-8 max-w-2xl rounded-lg border border-line/70 bg-panel/60 px-4 py-3 text-center text-sm text-muted">
            <span className="font-medium text-fg">Heads up:</span> rooms have no passwords. Anyone who knows the room
            name can read and edit it, so pick an unguessable name for anything private.
          </p>
        </section>
      </main>

      <footer className="border-t border-line px-5 py-5 text-center text-xs text-muted">
        DropDrop · Drop it. Share it. Sync it.
      </footer>
    </div>
  )
}
