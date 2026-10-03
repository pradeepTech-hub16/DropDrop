import { isDbConnected } from '../config/database.js'
import { sanitizeForLog } from '../utils/redact.js'

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } })
}

/** Reject DB-backed routes cleanly when MongoDB is unreachable. */
export function requireDatabase(_req, _res, next) {
  if (!isDbConnected()) {
    return next(new ApiError(503, 'DATABASE_UNAVAILABLE', 'The database is currently unavailable. Please try again shortly.'))
  }
  next()
}

export function notFound(req, res) {
  sendError(res, 404, 'NOT_FOUND', `No such endpoint: ${req.method} ${req.path}`)
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message)
  if (err.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.')
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.')
  }
  if (err.name === 'URIError') return sendError(res, 400, 'BAD_REQUEST', 'Malformed URL.')
  if (err.name === 'ValidationError') return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid room data.')
  // Never log request bodies, stack traces, or anything credential-like (connection strings, passwords, tokens).
  console.error('[error]', err?.name ?? 'Error', err?.code ? `code=${sanitizeForLog(err.code)}` : '', sanitizeForLog(err?.message))
  sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong on the server.')
}
