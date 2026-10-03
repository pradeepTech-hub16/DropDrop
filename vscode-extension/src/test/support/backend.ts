// Test harness: runs the REAL backend (backend/src/server.js, unmodified) against the isolated Atlas database
// "dropdrop_test". Connection strings are read from backend/.env and never printed or logged.
import { ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

export const TEST_DB = 'dropdrop_test'

function findBackendDir(): string {
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'backend')
    if (existsSync(path.join(candidate, 'src', 'server.js'))) return candidate
    dir = path.dirname(dir)
  }
  throw new Error('Could not locate the backend/ directory next to vscode-extension/')
}
export const BACKEND_DIR = findBackendDir()

function readEnvFile(): Record<string, string> {
  const file = path.join(BACKEND_DIR, '.env')
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/** The Atlas URI from backend/.env pointed at the isolated test database, or null if not configured. */
export function testMongoUri(): string | null {
  const uri = readEnvFile().MONGODB_URI
  if (!uri || /<db_password>|YOUR_PASSWORD|your_mongodb_atlas_connection_string/i.test(uri)) return null
  const url = new URL(uri)
  url.pathname = `/${TEST_DB}`
  return url.toString()
}

export const SKIP_REASON = testMongoUri() ? false : 'SKIPPED: backend/.env has no real MONGODB_URI (Atlas test database unavailable)'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

export interface BackendHandle {
  port: number
  apiUrl: string
  /** Base WebSocket URL; "/ws" is appended by the extension. */
  wsUrl: string
  /** Hard-stops the process (no graceful flush), like a crash. */
  kill(): Promise<void>
}

export async function startBackend(opts: { port?: number; clientUrl?: string } = {}): Promise<BackendHandle> {
  // Atlas occasionally needs a second try (DNS/SRV or TLS handshake hiccup); a persistent failure still throws.
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await startBackendOnce(opts)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

async function startBackendOnce(opts: { port?: number; clientUrl?: string } = {}): Promise<BackendHandle> {
  const uri = testMongoUri()
  if (!uri) throw new Error(SKIP_REASON as string)
  const port = opts.port ?? (await freePort())
  const child: ChildProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      MONGODB_URI: uri,
      PORT: String(port),
      CLIENT_URL: opts.clientUrl ?? 'http://localhost:5173',
      NODE_ENV: 'development',
      ELECTRON_RUN_AS_NODE: '1', // lets this work when process.execPath is VS Code's Electron
    },
    stdio: ['ignore', 'pipe', 'ignore'], // never surface stderr (could mention connection details)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backend did not start within 60s')), 60_000)
    child.stdout!.on('data', (d) => {
      if (String(d).includes('collaboration endpoint')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`backend exited early (code ${code})`))
    })
  })
  child.stdout!.resume()
  return {
    port,
    apiUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill()
      }),
  }
}

/** Deletes only rooms (and their update logs) whose names start with `prefix`, in the isolated test database. */
export function cleanupRooms(prefix: string): string {
  const uri = testMongoUri()
  if (!uri) return 'skipped'
  const script = `
    (async () => {
      const m = require('mongoose');
      await m.connect(process.env.TEST_URI);
      const f = { roomName: { $regex: '^' + process.env.PREFIX } };
      const u = await m.connection.collection('roomupdates').deleteMany(f);
      const r = await m.connection.collection('rooms').deleteMany(f);
      console.log('rooms=' + r.deletedCount + ' updates=' + u.deletedCount);
      await m.disconnect();
    })().catch(() => process.exit(1));`
  return execFileSync(process.execPath, ['-e', script], {
    cwd: BACKEND_DIR,
    env: { ...process.env, TEST_URI: uri, PREFIX: prefix, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  }).trim()
}

export async function waitFor(cond: () => unknown | Promise<unknown>, label: string, timeout = 15_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
