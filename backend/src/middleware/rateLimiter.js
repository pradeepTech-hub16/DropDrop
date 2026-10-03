import rateLimit from 'express-rate-limit'
import { sendError } from './errorHandler.js'

function build({ windowMs, limit }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Please slow down and try again in a moment.'),
  })
}

// Generous enough for debounced autosave (~1 save/second while typing), strict enough to blunt abuse.
export const createLimiters = ({ readLimit = 300, writeLimit = 120, windowMs = 60_000 } = {}) => ({
  read: build({ windowMs, limit: readLimit }),
  write: build({ windowMs, limit: writeLimit }),
})
