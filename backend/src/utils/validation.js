// Room name rules MUST stay identical to frontend/src/lib/room.js.
export const ROOM_NAME_MAX = 64
export const ROOM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// Max characters of room content (~500 KB of ASCII). Enforced here and in the schema.
export const MAX_CONTENT_LENGTH = 500_000

export const LANGUAGES = [
  'plaintext', 'javascript', 'typescript', 'python', 'json', 'html', 'css',
  'markdown', 'sql', 'java', 'cpp', 'go', 'rust', 'shell',
]

export function validateRoomName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'roomName is required.'
  if (name.length > ROOM_NAME_MAX) return `roomName can be at most ${ROOM_NAME_MAX} characters.`
  if (!ROOM_NAME_PATTERN.test(name)) {
    return 'roomName may only contain letters, numbers, "-" or "_", and must start with a letter or number.'
  }
  return null
}

export function validateContent(content) {
  if (typeof content !== 'string') return 'content must be a string.'
  if (content.length > MAX_CONTENT_LENGTH) {
    return `content is too large (${content.length} characters; maximum is ${MAX_CONTENT_LENGTH}).`
  }
  return null
}

export function validateLanguage(language) {
  if (typeof language !== 'string' || !LANGUAGES.includes(language)) {
    return `language must be one of: ${LANGUAGES.join(', ')}.`
  }
  return null
}
