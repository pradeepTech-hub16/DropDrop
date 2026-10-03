/**
 * Environment parsing and production safety checks.
 *
 *  ALLOWED_ORIGINS  trusted website origin(s), comma-separated. Used for CORS AND WebSocket Origin validation.
 *  CLIENT_URL       legacy alias of ALLOWED_ORIGINS (still supported). ALLOWED_ORIGINS wins if both are set.
 *  TRUST_PROXY      number of trusted reverse proxies in front of the app: false/0 (none), true (= 1), or 1-10.
 */
export function parseOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const DEV_DEFAULT_ORIGIN = 'http://localhost:5173'

/** Which variable supplies the origins, and what it contains. */
export function originsFromEnv(env = process.env) {
  const primary = String(env.ALLOWED_ORIGINS ?? '').trim()
  const legacy = String(env.CLIENT_URL ?? '').trim()
  const notes = []
  if (primary) {
    if (legacy && parseOrigins(legacy).join() !== parseOrigins(primary).join()) {
      notes.push('Both ALLOWED_ORIGINS and CLIENT_URL are set and differ; using ALLOWED_ORIGINS and ignoring CLIENT_URL.')
    }
    return { name: 'ALLOWED_ORIGINS', raw: primary, origins: parseOrigins(primary), notes }
  }
  return { name: legacy ? 'CLIENT_URL' : 'ALLOWED_ORIGINS', raw: legacy, origins: parseOrigins(legacy), notes }
}

/** TRUST_PROXY -> number of trusted proxy hops (0 = trust nothing). Returns null when invalid. */
export function parseTrustProxy(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === '' || v === 'false' || v === '0') return 0
  if (v === 'true') return 1
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 10 ? Number(v) : null
}

export const DEFAULT_FLUSH_INTERVAL_MS = 1000
export const FLUSH_INTERVAL_RANGE_MS = [250, 10_000]

/**
 * COLLAB_FLUSH_INTERVAL_MS: how often (at most) each active room is written to MongoDB.
 * Default 1000. Larger values cut database writes (useful on a free Atlas cluster, which allows ~100 operations/s)
 * but widen the window of edits that a sudden server crash can lose (see README, "Durability").
 */
export function parseFlushInterval(value) {
  const v = String(value ?? '').trim()
  if (v === '') return { value: DEFAULT_FLUSH_INTERVAL_MS, error: null }
  const n = Number(v)
  const [min, max] = FLUSH_INTERVAL_RANGE_MS
  if (!/^\d+$/.test(v) || n < min || n > max) {
    return {
      value: DEFAULT_FLUSH_INTERVAL_MS,
      error: `COLLAB_FLUSH_INTERVAL_MS must be a whole number of milliseconds from ${min} to ${max} (default ${DEFAULT_FLUSH_INTERVAL_MS}).`,
    }
  }
  return { value: n, error: null }
}

/**
 * Storage guard settings (refuses NEW rooms when the Atlas cluster is nearly full; never deletes anything).
 *   STORAGE_GUARD                      on (default) | off
 *   STORAGE_LIMIT_MB                   storage limit of the cluster tier (Atlas free = 512)
 *   STORAGE_GUARD_THRESHOLD            fraction of the limit at which new rooms are refused (0.5-0.95, default 0.8)
 *   STORAGE_OTHER_DB_RESERVE_MB        MB to assume other databases on the cluster use, ONLY applied when the
 *                                      cluster-wide size cannot be read (a least-privilege user cannot list databases)
 */
export function parseStorageConfig(env = process.env) {
  const errors = []
  const mode = String(env.STORAGE_GUARD ?? 'on').trim().toLowerCase()
  if (!['on', 'off'].includes(mode)) errors.push('STORAGE_GUARD must be "on" or "off".')
  const num = (name, def, min, max) => {
    const raw = String(env[name] ?? '').trim()
    if (raw === '') return def
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min || n > max) {
      errors.push(`${name} must be a number from ${min} to ${max}.`)
      return def
    }
    return n
  }
  return {
    enabled: mode !== 'off',
    limitMb: num('STORAGE_LIMIT_MB', 512, 16, 1_000_000),
    thresholdRatio: num('STORAGE_GUARD_THRESHOLD', 0.8, 0.5, 0.95),
    otherDatabasesReserveMb: num('STORAGE_OTHER_DB_RESERVE_MB', 0, 0, 1_000_000),
    errors,
  }
}

export function validateProductionConfig(env = process.env) {
  const errors = []
  const warnings = []
  const isProd = env.NODE_ENV === 'production'
  const found = originsFromEnv(env)
  warnings.push(...found.notes)
  let origins = found.origins

  const hops = parseTrustProxy(env.TRUST_PROXY)
  const flush = parseFlushInterval(env.COLLAB_FLUSH_INTERVAL_MS)
  if (flush.error) errors.push(flush.error)
  const storage = parseStorageConfig(env)
  errors.push(...storage.errors)
  if (hops === null) errors.push('TRUST_PROXY must be false, true (one proxy), or a number of trusted proxies from 1 to 10.')

  for (const o of origins) {
    if (o === '*' || o.includes('*')) errors.push(`${found.name} must list explicit origins; wildcard "${o}" is not allowed.`)
    else if (!/^https?:\/\/[^/\s]+$/i.test(o)) errors.push(`${found.name} entry "${o}" is not a valid origin (expected e.g. https://app.example.com, no path).`)
  }

  if (!isProd) {
    if (origins.length === 0) origins = [DEV_DEFAULT_ORIGIN]
    return { errors, warnings, origins, trustedProxyHops: hops ?? 0, flushIntervalMs: flush.value, storage }
  }

  if (origins.length === 0) errors.push('ALLOWED_ORIGINS (or the legacy CLIENT_URL) is required in production: the website origin, e.g. https://your-app.vercel.app.')
  for (const o of origins) {
    if (LOCAL.test(o)) warnings.push(`${found.name} contains a local origin (${o}); remove it for a real production deployment.`)
    else if (/^http:\/\//i.test(o)) errors.push(`${found.name} entry "${o}" must be https:// in production.`)
  }
  if (!env.MONGODB_URI) errors.push('MONGODB_URI is required.')
  if (hops === 0) {
    warnings.push('TRUST_PROXY is not set: behind a reverse proxy every client will appear to share the proxy\'s IP, so per-IP rate limits and connection limits will misbehave. Set it to the number of trusted proxies (usually 1).')
  }
  return { errors, warnings, origins, trustedProxyHops: hops ?? 0, flushIntervalMs: flush.value, storage }
}
