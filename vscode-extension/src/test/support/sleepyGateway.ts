// A proxy that behaves like a free-tier host whose server is asleep: until it "wakes", it answers 503 (like a
// hosting "waking up" page, with NO CORS headers), holds requests, or resets connections. After waking it forwards
// everything (HTTP and WebSocket upgrades) to the real backend. Used to test cold-start handling for real.
import http from 'node:http'
import net from 'node:net'

export type SleepMode = '503' | 'hold' | 'reset'

export interface GatewayOptions {
  targetPort: number
  mode?: SleepMode
  /** Wake automatically after this many ms (omit or Infinity = stay asleep until wakeNow()). */
  wakeAfterMs?: number
  port?: number
}

export interface GatewayHandle {
  port: number
  url: string
  /** Base WebSocket URL ("/ws" is added by clients). */
  wsUrl: string
  isAwake(): boolean
  wakeNow(): void
  /** Go back to sleep (new requests are refused/held again; already-open tunnels keep working). */
  sleepAgain(): void
  /** Everything that actually reached the real backend. */
  forwarded: Array<{ method: string; path: string }>
  stats: { hitsWhileAsleep: number; upgradesForwarded: number }
  stop(): Promise<void>
}

const rawHead = (req: http.IncomingMessage) => {
  let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
  for (let i = 0; i < req.rawHeaders.length; i += 2) head += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
  return head + '\r\n'
}

export async function startSleepyGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const mode = opts.mode ?? '503'
  let awake = false
  const held: Array<() => void> = []
  const sockets = new Set<net.Socket>()
  const forwarded: GatewayHandle['forwarded'] = []
  const stats = { hitsWhileAsleep: 0, upgradesForwarded: 0 }

  const server = http.createServer((req, res) => {
    const forward = () => {
      forwarded.push({ method: req.method ?? '', path: req.url ?? '' })
      const upstream = http.request({ host: '127.0.0.1', port: opts.targetPort, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers)
        ur.pipe(res)
      })
      upstream.on('error', () => {
        res.statusCode = 502
        res.end()
      })
      req.pipe(upstream)
    }
    if (awake) return forward()
    stats.hitsWhileAsleep++
    if (mode === '503') {
      res.writeHead(503, { 'Content-Type': 'text/html', 'Retry-After': '5' })
      res.end('<html><body>Service is waking up</body></html>')
    } else if (mode === 'reset') {
      req.socket.destroy()
    } else {
      held.push(() => !res.destroyed && forward()) // hold the request until the server "wakes"
    }
  })

  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  server.on('upgrade', (req, socket, head) => {
    const tunnel = () => {
      if (socket.destroyed) return
      stats.upgradesForwarded++
      const up = net.connect(opts.targetPort, '127.0.0.1', () => {
        up.write(rawHead(req))
        if (head.length) up.write(head)
        socket.pipe(up)
        up.pipe(socket)
      })
      up.on('error', () => socket.destroy())
      socket.on('error', () => up.destroy())
      socket.on('close', () => up.destroy())
    }
    if (awake) return tunnel()
    stats.hitsWhileAsleep++
    if (mode === '503') {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
    } else if (mode === 'reset') {
      socket.destroy()
    } else {
      held.push(tunnel)
    }
  })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const wakeNow = () => {
    awake = true
    for (const run of held.splice(0)) run()
  }
  const timer = opts.wakeAfterMs !== undefined && Number.isFinite(opts.wakeAfterMs) ? setTimeout(wakeNow, opts.wakeAfterMs) : null

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    isAwake: () => awake,
    wakeNow,
    sleepAgain: () => {
      awake = false
    },
    forwarded,
    stats,
    stop: async () => {
      if (timer) clearTimeout(timer)
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
