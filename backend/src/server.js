import 'dotenv/config'
import { createApp } from './app.js'
import { connectDatabase, disconnectDatabase } from './config/database.js'
import { CollabManager } from './collab/CollabManager.js'
import { attachCollabServer } from './collab/wsServer.js'
import { validateProductionConfig } from './config/env.js'
import { sanitizeForLog } from './utils/redact.js'
import { StorageGuard } from './services/storageGuard.js'
import './models/Room.js'
import './models/RoomUpdate.js'

// Anything that escapes every other handler is logged WITHOUT secrets (connection strings, passwords, tokens)
// and without stack traces, then the process exits so the host restarts it.
function fatal(label, err) {
  console.error(`[fatal] ${label}: ${err?.name ?? 'Error'}: ${sanitizeForLog(err?.message ?? err)}`)
  process.exit(1)
}
process.on('uncaughtException', (err) => fatal('uncaught exception', err))
process.on('unhandledRejection', (err) => fatal('unhandled rejection', err))

const PORT = Number(process.env.PORT) || 5000
const isProd = process.env.NODE_ENV === 'production'

const config = validateProductionConfig(process.env)
for (const w of config.warnings) console.warn(`[config] warning: ${w}`)
if (config.errors.length) {
  for (const e of config.errors) console.error(`[config] ${e}`)
  process.exit(1)
}
const allowedOrigins = config.origins
const trustedProxyHops = config.trustedProxyHops

try {
  await connectDatabase(process.env.MONGODB_URI)
  console.log('[db] connected to MongoDB')
} catch (err) {
  console.error(`[db] ${err.message}`)
  process.exit(1)
}

const storageGuard = new StorageGuard({
  enabled: config.storage.enabled,
  limitMb: config.storage.limitMb,
  thresholdRatio: config.storage.thresholdRatio,
  otherDatabasesReserveMb: config.storage.otherDatabasesReserveMb,
})
const collab = new CollabManager({ flushIntervalMs: config.flushIntervalMs, storageGuard })
const app = createApp({ clientUrl: allowedOrigins.join(','), collab, trustProxy: trustedProxyHops, storageGuard })

const server = app.listen(PORT, () => {
  console.log(`[api] DropDrop backend listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`)
  console.log(`[ws]  collaboration endpoint: /ws/<roomName>${isProd ? '' : ` (ws://localhost:${PORT})`}`)
  console.log(`[cors] allowed origins: ${allowedOrigins.join(', ')}; trusted proxies: ${trustedProxyHops}`)
  console.log(`[db]   persistence interval: ${config.flushIntervalMs} ms; storage guard: ${config.storage.enabled ? `on (new rooms refused at ~${Math.round(config.storage.limitMb * config.storage.thresholdRatio)} MB of ${config.storage.limitMb} MB)` : 'off'}`)
})
const ws = attachCollabServer(server, collab, { allowedOrigins, trustProxyHops: trustedProxyHops })

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  console.log('[server] shutting down: flushing open rooms to MongoDB…')
  server.close()
  await ws.close()
  await collab.shutdown() // persists every pending update before exit
  await disconnectDatabase()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
