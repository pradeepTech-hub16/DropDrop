// API tests against a throwaway in-memory MongoDB (mongodb-memory-server).
// These verify the application logic; they do NOT touch MongoDB Atlas (see atlas.smoke.test.js).
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import Room from '../src/models/Room.js'
import { MAX_CONTENT_LENGTH } from '../src/utils/validation.js'

let mongod
let app

before(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 90_000 } })
  await connectDatabase(mongod.getUri('dropdrop'))
  app = createApp({ clientUrl: 'http://localhost:5173' })
})

after(async () => {
  await app.locals.collab.shutdown()
  await disconnectDatabase()
  await mongod?.stop()
})

describe('health', () => {
  it('GET /api/health reports ok and database connected', async () => {
    const res = await request(app).get('/api/health')
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'ok')
    assert.equal(res.body.database, 'connected')
  })
})

describe('room lifecycle', () => {
  it('creates a new room (201, empty content, plaintext)', async () => {
    const res = await request(app).post('/api/rooms').send({ roomName: 'demo-room' })
    assert.equal(res.status, 201)
    assert.equal(res.body.created, true)
    assert.equal(res.body.room.roomName, 'demo-room')
    assert.equal(res.body.room.content, '')
    assert.equal(res.body.room.language, 'plaintext')
    assert.ok(res.body.room.createdAt && res.body.room.updatedAt)
  })

  it('retrieves an existing room', async () => {
    const res = await request(app).get('/api/rooms/demo-room')
    assert.equal(res.status, 200)
    assert.equal(res.body.room.roomName, 'demo-room')
  })

  it('updates content and language, then returns the updated data', async () => {
    const put = await request(app)
      .put('/api/rooms/demo-room')
      .send({ content: 'héllo 🌍\nline two', language: 'javascript' })
    assert.equal(put.status, 200)
    assert.equal(put.body.room.content, 'héllo 🌍\nline two')
    assert.equal(put.body.room.language, 'javascript')

    const get = await request(app).get('/api/rooms/demo-room')
    assert.equal(get.body.room.content, 'héllo 🌍\nline two')
    assert.equal(get.body.room.language, 'javascript')
    assert.ok(new Date(get.body.room.updatedAt) >= new Date(get.body.room.createdAt))
  })

  it('allows clearing content to an empty string', async () => {
    const put = await request(app).put('/api/rooms/demo-room').send({ content: '' })
    assert.equal(put.status, 200)
    assert.equal(put.body.room.content, '')
  })

  it('creating an existing room returns it (200, created:false) without resetting content', async () => {
    await request(app).put('/api/rooms/dup-room').send({ content: 'x' }) // 404 first, room not there yet
    await request(app).post('/api/rooms').send({ roomName: 'dup-room' })
    await request(app).put('/api/rooms/dup-room').send({ content: 'keep me' })
    const again = await request(app).post('/api/rooms').send({ roomName: 'dup-room' })
    assert.equal(again.status, 200)
    assert.equal(again.body.created, false)
    assert.equal(again.body.room.content, 'keep me')
    assert.equal(await Room.countDocuments({ roomName: 'dup-room' }), 1)
  })

  it('concurrent creates of the same room yield exactly one record', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => request(app).post('/api/rooms').send({ roomName: 'race-room' })),
    )
    assert.ok(results.every((r) => r.status === 200 || r.status === 201), results.map((r) => r.status).join())
    assert.equal(results.filter((r) => r.status === 201).length, 1)
    assert.equal(await Room.countDocuments({ roomName: 'race-room' }), 1)
  })

  it('room names are case-sensitive, matching the frontend rules', async () => {
    await request(app).post('/api/rooms').send({ roomName: 'CaseRoom' })
    assert.equal((await request(app).get('/api/rooms/caseroom')).status, 404)
    assert.equal((await request(app).get('/api/rooms/CaseRoom')).status, 200)
  })

  it('never exposes Yjs internals or Mongo ids', async () => {
    const res = await request(app).get('/api/rooms/demo-room')
    assert.deepEqual(Object.keys(res.body.room).sort(), ['content', 'createdAt', 'language', 'roomName', 'updatedAt'])
  })
})

describe('validation and errors', () => {
  const badNames = ['bad name', '-leading', '_leading', 'a'.repeat(65), 'semi;colon', 'dot.dot', 'ünïcode']

  for (const name of badNames) {
    it(`rejects invalid room name on create: ${JSON.stringify(name.slice(0, 20))}`, async () => {
      const res = await request(app).post('/api/rooms').send({ roomName: name })
      assert.equal(res.status, 400)
      assert.equal(res.body.error.code, 'INVALID_ROOM_NAME')
      assert.ok(res.body.error.message.length > 10)
    })
  }

  it('rejects missing/non-string room name', async () => {
    for (const body of [{}, { roomName: 123 }, { roomName: { $ne: null } }, { roomName: '' }]) {
      const res = await request(app).post('/api/rooms').send(body)
      assert.equal(res.status, 400, JSON.stringify(body))
    }
  })

  it('rejects invalid room name on GET and PUT', async () => {
    assert.equal((await request(app).get('/api/rooms/bad%20name')).status, 400)
    assert.equal((await request(app).put('/api/rooms/bad%20name').send({ content: 'x' })).status, 400)
  })

  it('returns 404 with a helpful error for a nonexistent room (GET and PUT)', async () => {
    const get = await request(app).get('/api/rooms/does-not-exist')
    assert.equal(get.status, 404)
    assert.equal(get.body.error.code, 'ROOM_NOT_FOUND')
    const put = await request(app).put('/api/rooms/does-not-exist').send({ content: 'x' })
    assert.equal(put.status, 404)
    assert.equal(await Room.countDocuments({ roomName: 'does-not-exist' }), 0, 'PUT must not create rooms')
  })

  it('rejects oversized content with 413 and leaves stored content unchanged', async () => {
    await request(app).put('/api/rooms/demo-room').send({ content: 'safe' })
    const res = await request(app)
      .put('/api/rooms/demo-room')
      .send({ content: 'a'.repeat(MAX_CONTENT_LENGTH + 1) })
    assert.equal(res.status, 413)
    assert.equal(res.body.error.code, 'CONTENT_TOO_LARGE')
    assert.equal((await request(app).get('/api/rooms/demo-room')).body.room.content, 'safe')
  })

  it('accepts content exactly at the limit', async () => {
    const res = await request(app)
      .put('/api/rooms/demo-room')
      .send({ content: 'a'.repeat(MAX_CONTENT_LENGTH) })
    assert.equal(res.status, 200)
    await request(app).put('/api/rooms/demo-room').send({ content: '' })
  })

  it('rejects a request body larger than the parser limit with 413', async () => {
    const res = await request(app)
      .put('/api/rooms/demo-room')
      .send({ content: 'a'.repeat(3 * 1024 * 1024) })
    assert.equal(res.status, 413)
  })

  it('rejects bad content type, bad language, empty update and malformed JSON', async () => {
    const a = await request(app).put('/api/rooms/demo-room').send({ content: 42 })
    assert.equal(a.status, 400)
    assert.equal(a.body.error.code, 'INVALID_CONTENT')
    const b = await request(app).put('/api/rooms/demo-room').send({ language: 'klingon' })
    assert.equal(b.status, 400)
    assert.equal(b.body.error.code, 'INVALID_LANGUAGE')
    const c = await request(app).put('/api/rooms/demo-room').send({})
    assert.equal(c.status, 400)
    const d = await request(app).post('/api/rooms').set('Content-Type', 'application/json').send('{not json')
    assert.equal(d.status, 400)
    assert.equal(d.body.error.code, 'INVALID_JSON')
  })

  it('returns a consistent JSON error for unknown endpoints', async () => {
    const res = await request(app).get('/api/nope')
    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'NOT_FOUND')
  })
})

describe('security middleware', () => {
  it('sends Helmet headers and hides x-powered-by', async () => {
    const res = await request(app).get('/api/health')
    assert.ok(res.headers['x-content-type-options'])
    assert.equal(res.headers['x-powered-by'], undefined)
  })

  it('allows the configured CORS origin and not others', async () => {
    const ok = await request(app).get('/api/health').set('Origin', 'http://localhost:5173')
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173')
    const bad = await request(app).get('/api/health').set('Origin', 'http://evil.example')
    assert.equal(bad.headers['access-control-allow-origin'], undefined)
  })

  it('rate-limits requests with a 429 JSON error', async () => {
    const limited = createApp({ rateLimits: { readLimit: 3, writeLimit: 3 } })
    const statuses = []
    for (let i = 0; i < 5; i++) statuses.push((await request(limited).get('/api/rooms/demo-room')).status)
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200])
    assert.equal(statuses[4], 429)
    const res = await request(limited).get('/api/rooms/demo-room')
    assert.equal(res.body.error.code, 'RATE_LIMITED')
  })
})

describe('REST rate limiting behind a reverse proxy (X-Forwarded-For is client-controlled)', () => {
  const hit = async (a, xff) => (await request(a).get('/api/rooms/demo-room').set('X-Forwarded-For', xff)).status
  const quiet = async (fn) => {
    // express-rate-limit logs a (harmless) warning when the header is present but untrusted; keep test output clean
    const orig = console.error
    console.error = () => {}
    try {
      return await fn()
    } finally {
      console.error = orig
    }
  }

  it('trusting one proxy: forged leading entries cannot dodge the limit (same real client => 429)', async () => {
    const a = createApp({ rateLimits: { readLimit: 2, writeLimit: 2 }, trustProxy: 1 })
    const statuses = []
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) statuses.push(await hit(a, `${forged}, 198.51.100.7`))
    assert.deepEqual(statuses, [200, 200, 429, 429])
  })

  it('trusting one proxy: different real clients get separate allowances', async () => {
    const a = createApp({ rateLimits: { readLimit: 1, writeLimit: 1 }, trustProxy: 1 })
    assert.equal(await hit(a, '9.9.9.9, 198.51.100.1'), 200)
    assert.equal(await hit(a, '9.9.9.9, 198.51.100.2'), 200)
    assert.equal(await hit(a, '9.9.9.9, 198.51.100.1'), 429)
  })

  it('trusting nothing: the header is ignored, so a forged value cannot create a fresh allowance', async () => {
    const a = createApp({ rateLimits: { readLimit: 2, writeLimit: 2 }, trustProxy: false })
    const statuses = await quiet(async () => {
      const out = []
      for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) out.push(await hit(a, forged))
      return out
    })
    assert.deepEqual(statuses, [200, 200, 429])
  })
})

describe('GET /api/client-ip (TRUST_PROXY diagnostic)', () => {
  it('reports the caller\'s own address with the configured hop count', async () => {
    const one = createApp({ trustProxy: 1 })
    const res = await request(one).get('/api/client-ip').set('X-Forwarded-For', '1.2.3.4, 198.51.100.7')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ip: '198.51.100.7', trustedProxyHops: 1 })
  })
  it('ignores X-Forwarded-For entirely when no proxy is trusted', async () => {
    const none = createApp({ trustProxy: false })
    const res = await request(none).get('/api/client-ip').set('X-Forwarded-For', '198.51.100.7')
    assert.equal(res.body.trustedProxyHops, 0)
    assert.match(res.body.ip, /^(::ffff:)?127\.0\.0\.1$|^::1$/)
  })
})
