// Removes anything that looks like a credential from text that is about to be logged.
const MAX_LOG_LENGTH = 500
const SECRET_ENV_KEY = /(URI|URL|PASSWORD|PASS|PWD|SECRET|TOKEN|KEY)/i

/** Concrete secret values currently configured in the environment (and pieces of connection strings). */
function configuredSecrets(env) {
  const out = new Set()
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 6 || !SECRET_ENV_KEY.test(key)) continue
    if (/^NODE_ENV$|^PORT$/.test(key)) continue
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(value)) continue // dev URLs are not secrets
    out.add(value)
    try {
      const u = new URL(value)
      if (u.password) {
        out.add(u.password)
        out.add(decodeURIComponent(u.password))
      }
      if (u.username && u.password) out.add(decodeURIComponent(u.username))
    } catch {
      /* not a URL */
    }
  }
  return [...out].sort((a, b) => b.length - a.length)
}

export function sanitizeForLog(input, env = process.env) {
  let text = typeof input === 'string' ? input : String(input ?? '')
  for (const secret of configuredSecrets(env)) text = text.split(secret).join('<redacted>')
  text = text
    .replace(/mongodb(\+srv)?:\/\/[^\s'"`<>]+/gi, 'mongodb://<redacted>') // any connection string
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@'"`]+@/gi, '<scheme>://<redacted>@') // user:pass@ in any URL
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted-token>')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s,;"'&]+/gi, '$1$2<redacted>')
  return text.length > MAX_LOG_LENGTH ? `${text.slice(0, MAX_LOG_LENGTH)}…[truncated]` : text
}
