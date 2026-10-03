// Pure URL validation/normalisation for the three server settings (no vscode dependency, fully unit-tested).

export interface EndpointSettings {
  apiUrl: string
  websocketUrl: string
  publicAppUrl: string
}

export interface Endpoints {
  /** REST base, no trailing slash, e.g. https://api.example.com */
  apiUrl: string
  /** WebSocket base ending in /ws, e.g. wss://api.example.com/ws (room name is appended by the provider) */
  wsUrl: string
  /** Public website base used for share links, e.g. https://dropdrop.vercel.app (may be '' if unset) */
  publicAppUrl: string
}

export interface ResolvedEndpoints {
  endpoints: Endpoints | null
  errors: string[]
  warnings: string[]
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i

function parse(raw: string, protocols: string[], setting: string, errors: string[]): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    errors.push(`${setting} "${raw}" is not a valid URL. Expected something like ${protocols[0]}//example.com`)
    return null
  }
  if (!protocols.includes(url.protocol)) {
    errors.push(`${setting} must start with ${protocols.map((p) => p + '//').join(' or ')} (got "${url.protocol}//").`)
    return null
  }
  if (url.username || url.password) {
    errors.push(`${setting} must not contain a username or password.`)
    return null
  }
  return url
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')
const isLocal = (u: URL) => LOCAL_HOST.test(u.hostname)

export function resolveEndpoints(input: EndpointSettings): ResolvedEndpoints {
  const errors: string[] = []
  const warnings: string[] = []

  const api = parse((input.apiUrl ?? '').trim(), ['http:', 'https:'], 'dropdrop.apiUrl', errors)

  let ws: URL | null = null
  const wsRaw = (input.websocketUrl ?? '').trim()
  if (wsRaw) {
    ws = parse(wsRaw, ['ws:', 'wss:'], 'dropdrop.websocketUrl', errors)
  } else if (api) {
    ws = new URL(api.href.replace(/^http/i, 'ws')) // https -> wss, http -> ws
  }

  let publicApp: URL | null = null
  const publicRaw = (input.publicAppUrl ?? '').trim()
  if (publicRaw) publicApp = parse(publicRaw, ['http:', 'https:'], 'dropdrop.publicAppUrl', errors)
  else warnings.push('dropdrop.publicAppUrl is not set, so "Copy Room Link" cannot build a website link.')

  if (api && ws) {
    if (api.protocol === 'https:' && ws.protocol === 'ws:' && !isLocal(ws)) {
      errors.push('dropdrop.apiUrl is https:// but dropdrop.websocketUrl is ws://. Use wss:// for a secure server.')
    }
    if (api.protocol === 'http:' && !isLocal(api)) {
      warnings.push('dropdrop.apiUrl uses plain http:// to a non-local host. Use https:// so room contents are encrypted in transit.')
    }
    if (ws.protocol === 'ws:' && !isLocal(ws)) {
      warnings.push('dropdrop.websocketUrl uses plain ws:// to a non-local host. Use wss://.')
    }
  }

  if (errors.length || !api || !ws) return { endpoints: null, errors, warnings }

  const wsPath = trimSlash(ws.pathname)
  const wsBase = `${ws.protocol}//${ws.host}${wsPath.endsWith('/ws') ? wsPath : `${wsPath}/ws`}`
  return {
    endpoints: {
      apiUrl: trimSlash(api.origin + trimSlash(api.pathname)),
      wsUrl: wsBase,
      publicAppUrl: publicApp ? trimSlash(publicApp.origin + trimSlash(publicApp.pathname)) : '',
    },
    errors,
    warnings,
  }
}

export function roomShareUrl(endpoints: Pick<Endpoints, 'publicAppUrl'>, roomName: string): string | null {
  if (!endpoints.publicAppUrl) return null
  return `${endpoints.publicAppUrl}/${encodeURIComponent(roomName)}`
}

/** Thrown when the extension settings are invalid; `message` is user-presentable. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('\n'))
    this.name = 'ConfigError'
  }
}

/** Resolve settings or throw a ConfigError listing every problem. */
export function requireEndpoints(input: EndpointSettings): Endpoints {
  const r = resolveEndpoints(input)
  if (!r.endpoints) throw new ConfigError(r.errors)
  return r.endpoints
}
