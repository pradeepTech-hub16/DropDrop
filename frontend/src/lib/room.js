import { config } from './config.js'

// Room name rules. The backend (Phase 2) must enforce the same pattern.
export const ROOM_NAME_MAX = 64
// Must match MAX_CONTENT_LENGTH in backend/src/utils/validation.js
export const ROOM_CONTENT_MAX = 500_000
export const ROOM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function validateRoomName(name) {
  if (!name) return 'Enter a room name.'
  if (name.length > ROOM_NAME_MAX) return `Room names can be at most ${ROOM_NAME_MAX} characters.`
  if (!ROOM_NAME_PATTERN.test(name)) {
    return 'Use letters, numbers, "-" or "_" only, starting with a letter or number.'
  }
  return null
}

export function randomRoomName() {
  const words = ['mint', 'drop', 'byte', 'pixel', 'nova', 'echo', 'loop', 'sync', 'delta', 'orbit']
  const word = words[Math.floor(Math.random() * words.length)]
  return `${word}-${Math.random().toString(36).slice(2, 6)}`
}

export function roomUrl(name) {
  return `${config.PUBLIC_APP_URL || window.location.origin}/${encodeURIComponent(name)}`
}
