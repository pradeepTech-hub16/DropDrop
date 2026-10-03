// Room rules. MUST stay identical to frontend/src/lib/room.js and backend/src/utils/validation.js.
export const ROOM_NAME_MAX = 64
export const ROOM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
export const ROOM_CONTENT_MAX = 500_000

export function validateRoomName(name: string | undefined | null): string | null {
  if (!name) return 'Enter a room name.'
  if (name.length > ROOM_NAME_MAX) return `Room names can be at most ${ROOM_NAME_MAX} characters.`
  if (!ROOM_NAME_PATTERN.test(name)) {
    return 'Use letters, numbers, "-" or "_" only, starting with a letter or number.'
  }
  return null
}

export function randomRoomName(): string {
  const words = ['mint', 'drop', 'byte', 'pixel', 'nova', 'echo', 'loop', 'sync', 'delta', 'orbit']
  const word = words[Math.floor(Math.random() * words.length)]
  return `${word}-${Math.random().toString(36).slice(2, 6)}`
}

export interface LanguageOption {
  id: string
  label: string
}

// ids must match backend LANGUAGES
export const LANGUAGES: LanguageOption[] = [
  { id: 'plaintext', label: 'Plain text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'sql', label: 'SQL' },
  { id: 'java', label: 'Java' },
  { id: 'cpp', label: 'C++' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'shell', label: 'Shell' },
]

export const ACCESS_WARNING =
  'DropDrop rooms have no passwords: anyone who knows a room name can read and edit it. Use an unguessable name for anything private.'
