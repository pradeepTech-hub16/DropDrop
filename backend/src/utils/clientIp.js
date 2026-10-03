import net from 'node:net'

/** "::ffff:1.2.3.4" (IPv4-mapped IPv6) -> "1.2.3.4". */
export function normalizeIp(ip) {
  const s = String(ip ?? '').trim()
  return s.toLowerCase().startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s
}

/**
 * Real client address, safe against forged `X-Forwarded-For` values.
 *
 * `trustedProxyHops` is the number of reverse proxies YOU operate/trust in front of this process (0 = none).
 * Each trusted proxy appends the address it received the connection from, so the real client is the
 * Nth entry counted from the RIGHT. Anything further left was supplied by the client (or by untrusted
 * hops) and is ignored. If the header is missing, too short, or the selected entry is not an IP address,
 * the direct peer address is used instead (never an attacker-chosen string).
 */
export function clientIpFromRequest(req, trustedProxyHops = 0) {
  const peer = normalizeIp(req.socket?.remoteAddress) || 'unknown'
  if (!trustedProxyHops || trustedProxyHops < 1) return peer
  const header = req.headers?.['x-forwarded-for']
  if (!header) return peer
  const entries = (Array.isArray(header) ? header.join(',') : String(header)).split(',').map((s) => s.trim()).filter(Boolean)
  const candidate = normalizeIp(entries[entries.length - trustedProxyHops])
  return candidate && net.isIP(candidate) ? candidate : peer
}
