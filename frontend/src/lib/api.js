import { config } from './config.js'

const API_URL = config.API_URL

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status // 0 = could not reach the server at all
    this.code = code
  }
}

async function request(method, path, body, { keepalive = false, signal } = {}) {
  let res
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive,
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err // cancelled by the caller: not a network failure
    throw new ApiError(0, 'NETWORK', `Can't reach the DropDrop server at ${API_URL}. Is the backend running?`)
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'HTTP_ERROR',
      data?.error?.message ?? `Server responded with ${res.status}.`,
    )
  }
  return data
}

const enc = encodeURIComponent

/** Create the room if missing, otherwise return the existing one. */
export const createRoom = (roomName, opts) => request('POST', '/api/rooms', { roomName }, opts).then((d) => d.room)

export const getRoom = (roomName) => request('GET', `/api/rooms/${enc(roomName)}`).then((d) => d.room)

export const updateRoom = (roomName, fields, opts) =>
  request('PUT', `/api/rooms/${enc(roomName)}`, fields, opts).then((d) => d.room)

/** Load a room, creating it first if this is a brand-new name. */
export async function openRoom(roomName) {
  try {
    return await getRoom(roomName)
  } catch (err) {
    if (err.status === 404) return createRoom(roomName)
    throw err
  }
}
