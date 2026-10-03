import Room from '../models/Room.js'
import { ApiError } from '../middleware/errorHandler.js'
import {
  MAX_CONTENT_LENGTH,
  validateContent,
  validateLanguage,
  validateRoomName,
} from '../utils/validation.js'

function assertValidName(name) {
  const problem = validateRoomName(name)
  if (problem) throw new ApiError(400, 'INVALID_ROOM_NAME', problem)
}

/** POST /api/rooms  — create the room if missing, otherwise return the existing one. */
export async function createRoom(req, res) {
  assertValidName(req.body?.roomName)
  const { roomName } = req.body

  // Storage guard: when the cluster is nearly full, refuse to create NEW rooms (existing ones are returned as usual).
  const guard = req.app.locals.storageGuard
  if (guard && !(await Room.exists({ roomName }))) {
    if (!(await guard.status()).allowNewRooms) {
      throw new ApiError(503, 'STORAGE_FULL', "New rooms are temporarily disabled because DropDrop's free storage is nearly full. Existing rooms keep working; please try again later.")
    }
  }

  let room
  let created
  try {
    // Atomic upsert: concurrent creates can never produce two records.
    const result = await Room.findOneAndUpdate(
      { roomName },
      { $setOnInsert: { roomName, content: '', language: 'plaintext' } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true, setDefaultsOnInsert: true },
    )
    room = result.value
    created = !result.lastErrorObject?.updatedExisting
  } catch (err) {
    if (err?.code !== 11000) throw err
    // Lost an upsert race against the unique index: the room now exists, so just read it.
    room = await Room.findOne({ roomName })
    created = false
  }
  res.status(created ? 201 : 200).json({ created, room })
}

/** GET /api/rooms/:roomName */
export async function getRoom(req, res) {
  assertValidName(req.params.roomName)
  // If the room is live, persist its current state first so the plain-text mirror is up to date.
  await req.app.locals.collab.flushRoom(req.params.roomName)
  const room = await Room.findOne({ roomName: req.params.roomName })
  if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', `Room "${req.params.roomName}" does not exist.`)
  res.json({ room })
}

/** PUT /api/rooms/:roomName — replace content and/or language. */
export async function updateRoom(req, res) {
  assertValidName(req.params.roomName)
  const { content, language } = req.body ?? {}
  if (content === undefined && language === undefined) {
    throw new ApiError(400, 'NOTHING_TO_UPDATE', 'Provide content and/or language.')
  }

  const update = {}
  if (content !== undefined) {
    const problem = validateContent(content)
    if (problem) {
      const tooLarge = typeof content === 'string' && content.length > MAX_CONTENT_LENGTH
      throw new ApiError(tooLarge ? 413 : 400, tooLarge ? 'CONTENT_TOO_LARGE' : 'INVALID_CONTENT', problem)
    }
    update.content = content
  }
  if (language !== undefined) {
    const problem = validateLanguage(language)
    if (problem) throw new ApiError(400, 'INVALID_LANGUAGE', problem)
    update.language = language
  }

  if (!(await Room.exists({ roomName: req.params.roomName }))) {
    throw new ApiError(404, 'ROOM_NOT_FOUND', `Room "${req.params.roomName}" does not exist.`)
  }
  // Applied through the live Yjs document as a minimal diff: merges with (never overwrites) collaborative edits.
  await req.app.locals.collab.applyRest(req.params.roomName, update)
  const room = await Room.findOne({ roomName: req.params.roomName })
  res.json({ room })
}
