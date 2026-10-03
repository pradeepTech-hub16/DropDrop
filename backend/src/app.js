import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { isDbConnected } from './config/database.js'
import { createLimiters } from './middleware/rateLimiter.js'
import { errorHandler, notFound, requireDatabase } from './middleware/errorHandler.js'
import roomRoutes from './routes/roomRoutes.js'
import { normalizeIp } from './utils/clientIp.js'
import { CollabManager } from './collab/CollabManager.js'

/**
 * Builds the Express app without listening or connecting to the database,
 * so tests (and later the WebSocket server) can reuse it.
 */
export function createApp({ clientUrl = 'http://localhost:5173', rateLimits, collab = new CollabManager(), trustProxy = false, storageGuard = null } = {}) {
  const app = express()
  // Number of trusted reverse proxies (true = 1). Express then derives req.ip from the right-hand side of
  // X-Forwarded-For, so client-forged entries cannot dodge the REST rate limiter. 0/false = trust nothing.
  const hops = trustProxy === true ? 1 : Number(trustProxy) || 0
  if (hops > 0) app.set('trust proxy', hops)
  app.locals.collab = collab // shared with the WebSocket server so REST and live editing use one document
  app.locals.storageGuard = storageGuard // refuses NEW rooms when storage is nearly full (null = no guard)
  const allowedOrigins = clientUrl.split(',').map((s) => s.trim()).filter(Boolean)

  app.use(helmet())
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
      methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    }),
  )
  // Slightly above MAX_CONTENT_LENGTH chars so multi-byte text isn't rejected by the body parser first.
  app.use(express.json({ limit: '2mb' }))

  // Diagnostic for choosing TRUST_PROXY on a new host: open it from your own browser; `ip` must be YOUR public
  // address. If it shows a proxy/edge address, raise TRUST_PROXY by one; if it shows something forgeable, lower it.
  // Only reveals the caller's own address to the caller.
  app.get('/api/client-ip', (req, res) => {
    res.json({ ip: normalizeIp(req.ip), trustedProxyHops: hops })
  })

  app.get('/api/health', (_req, res) => {
    const db = isDbConnected()
    res.status(db ? 200 : 503).json({
      status: db ? 'ok' : 'degraded',
      database: db ? 'connected' : 'disconnected',
      uptime: Math.round(process.uptime()),
      // Coarse state only, from the last measurement (never triggers one, never exposes sizes).
      ...(storageGuard ? { storage: storageGuard.publicSummary(storageGuard.peek()) } : {}),
      timestamp: new Date().toISOString(),
    })
  })

  app.use('/api/rooms', requireDatabase, roomRoutes(createLimiters(rateLimits)))

  app.use(notFound)
  app.use(errorHandler)
  return app
}
