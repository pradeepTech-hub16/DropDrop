const STYLES = {
  connected: { dot: 'bg-mint', text: 'text-mint', label: 'Connected' },
  connecting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'Connecting…' },
  offline: { dot: 'bg-zinc-500', text: 'text-muted', label: 'Local only' },
  error: { dot: 'bg-red-400', text: 'text-red-300', label: 'Disconnected' },
}

export default function StatusPill({ status, label, title }) {
  const s = STYLES[status] ?? STYLES.offline
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs font-medium ${s.text}`}
    >
      <span className={`h-2 w-2 rounded-full ${s.dot}`} />
      {label ?? s.label}
    </span>
  )
}
