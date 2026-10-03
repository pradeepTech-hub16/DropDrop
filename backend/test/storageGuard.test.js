// F3: conservative storage guard. Unit tests use fake Mongo clients (no database); integration tests use a real
// throwaway in-memory MongoDB. Nothing here touches the real Atlas "dropdrop" database.
import { after, before, afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import Room from '../src/models/Room.js'
import RoomUpdate from '../src/models/RoomUpdate.js'
import { StorageGuard } from '../src/services/storageGuard.js'
import { connectClient, rawSocket, sleep, startServer, waitFor } from './collab-helpers.js'

const MB = 1024 * 1024
const quiet = { log: () => {} }

/** Fake driver client. `listed` and `own` are the bytes returned, or an Error to throw. */
function fakeClient({ listed, own }) {
  const calls = { listDatabases: 0, dbStats: 0 }
  const client = {
    db: (name) => ({
      admin: () => ({
        listDatabases: async () => {
          calls.listDatabases++
          if (listed instanceof Error) throw listed
          return { totalSize: listed }
        },
      }),
      command: async () => {
        calls.dbStats++
        if (own instanceof Error) throw own
        return { storageSize: own, indexSize: 0 }
      },
    }),
  }
  return { client, calls }
}
const guardFor = (fake, opts = {}) => new StorageGuard({ getClient: () => fake.client, getDbName: () => 'dropdrop', limitMb: 100, thresholdRatio: 0.8, ...quiet, ...opts })

describe('StorageGuard: measuring (unit)', () => {
  it('cluster-wide measurement below the threshold allows new rooms', async () => {
    const g = guardFor(fakeClient({ listed: 50 * MB }))
    const s = await g.status()
    assert.deepEqual([s.allowNewRooms, s.state, s.source], [true, 'ok', 'cluster'])
  })

  it('refuses new rooms at/above the threshold (limit 100 MB x 0.8 = 80 MB), allows just below', async () => {
    assert.equal((await guardFor(fakeClient({ listed: 80 * MB })).status()).allowNewRooms, false)
    assert.equal((await guardFor(fakeClient({ listed: 79.9 * MB })).status()).allowNewRooms, true)
    const s = await guardFor(fakeClient({ listed: 95 * MB })).status()
    assert.deepEqual([s.allowNewRooms, s.state, s.source], [false, 'refusing', 'cluster'])
  })

  it('counts OTHER databases on the cluster (cluster total, not just DropDrop)', async () => {
    // DropDrop itself is tiny; the cluster total is dominated by other databases
    const fake = fakeClient({ listed: 85 * MB, own: 0.2 * MB })
    const s = await guardFor(fake).status()
    assert.equal(s.allowNewRooms, false)
    assert.equal(fake.calls.dbStats, 0, 'own-database size was not even needed')
  })

  it('without permission to list databases it estimates from its own database PLUS the declared reserve', async () => {
    const denied = new Error('not authorized on admin to execute command listDatabases')
    const refusing = await guardFor(fakeClient({ listed: denied, own: 10 * MB }), { otherDatabasesReserveMb: 75 }).status()
    assert.deepEqual([refusing.allowNewRooms, refusing.state, refusing.source], [false, 'refusing', 'estimate'])
    const ok = await guardFor(fakeClient({ listed: denied, own: 10 * MB }), { otherDatabasesReserveMb: 20 }).status()
    assert.deepEqual([ok.allowNewRooms, ok.state, ok.source], [true, 'ok', 'estimate'])
  })

  it('without permission AND without a declared reserve the answer is "unknown" and it fails open (no guessing)', async () => {
    const s = await guardFor(fakeClient({ listed: new Error('denied'), own: 90 * MB })).status()
    assert.deepEqual([s.allowNewRooms, s.state, s.source], [true, 'unknown', 'estimate'])
  })

  it('if nothing can be measured it reports "unavailable"/"unknown" and fails open', async () => {
    const s = await guardFor(fakeClient({ listed: new Error('x'), own: new Error('y') })).status()
    assert.deepEqual([s.allowNewRooms, s.state, s.source], [true, 'unknown', 'unavailable'])
    const broken = new StorageGuard({ getClient: () => { throw new Error('not connected') }, ...quiet })
    assert.equal((await broken.status()).state, 'unknown')
  })

  it('can be disabled', async () => {
    const fake = fakeClient({ listed: 99 * MB })
    const s = await guardFor(fake, { enabled: false }).status()
    assert.deepEqual([s.allowNewRooms, s.state], [true, 'disabled'])
    assert.equal(fake.calls.listDatabases, 0)
  })

  it('the public summary exposes only a coarse state and the source, never sizes', async () => {
    const g = guardFor(fakeClient({ listed: 90 * MB }))
    const summary = g.publicSummary(await g.status())
    assert.deepEqual(summary, { guard: 'refusing-new-rooms', source: 'cluster' })
    assert.ok(!JSON.stringify(summary).match(/\d/), 'no numbers')
    assert.deepEqual(g.publicSummary(g.peek()).guard, 'refusing-new-rooms')
    assert.equal(new StorageGuard({ ...quiet }).peek().state, 'unknown', 'peek before any measurement does not measure')
  })
})

describe('StorageGuard: caching (unit)', () => {
  it('caches for the TTL, then re-measures', async () => {
    let t = 0
    const fake = fakeClient({ listed: 10 * MB })
    const g = guardFor(fake, { ttlMs: 60_000, now: () => t })
    await g.status(); await g.status(); await g.status()
    assert.equal(fake.calls.listDatabases, 1)
    t = 59_000
    await g.status()
    assert.equal(fake.calls.listDatabases, 1)
    t = 61_000
    await g.status()
    assert.equal(fake.calls.listDatabases, 2)
  })

  it('concurrent callers share one in-flight measurement', async () => {
    const fake = fakeClient({ listed: 10 * MB })
    const g = guardFor(fake)
    await Promise.all(Array.from({ length: 25 }, () => g.status()))
    assert.equal(fake.calls.listDatabases, 1)
  })

  it('failed measurements are retried sooner than successful ones', async () => {
    let t = 0
    const fake = fakeClient({ listed: new Error('x'), own: new Error('y') })
    const g = guardFor(fake, { ttlMs: 60_000, errorTtlMs: 5_000, now: () => t })
    await g.status()
    t = 6_000
    await g.status()
    assert.equal(fake.calls.listDatabases, 2)
  })
})

describe('StorageGuard: behaviour of the server (integration, in-memory MongoDB)', () => {
  let mongod
  const cleanups = []
  before(async () => {
    mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 90_000 } })
    await connectDatabase(mongod.getUri('dropdrop'))
  })
  after(async () => {
    await disconnectDatabase()
    await mongod?.stop()
  })
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()()
  })

  const refusing = { status: async () => ({ allowNewRooms: false, state: 'refusing', source: 'cluster', approxUsedMb: 450 }), peek: () => ({ state: 'refusing', source: 'cluster' }), publicSummary: (s) => ({ guard: 'refusing-new-rooms', source: s.source }) }
  const counts = async () => ({ rooms: await Room.countDocuments({}), updates: await RoomUpdate.countDocuments({}) })
  let n = 0
  const name = () => `guard-${process.pid}-${++n}`

  it('REST: a NEW room is refused with 503 STORAGE_FULL and nothing is created; EXISTING rooms are unaffected', async () => {
    const open = createApp({})
    const existing = name()
    assert.equal((await request(open).post('/api/rooms').send({ roomName: existing })).status, 201)
    await request(open).put(`/api/rooms/${existing}`).send({ content: 'keep me' })

    const app = createApp({ storageGuard: refusing })
    const before = await counts()
    const fresh = name()
    const res = await request(app).post('/api/rooms').send({ roomName: fresh })
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'STORAGE_FULL')
    assert.match(res.body.error.message, /Existing rooms keep working/)
    assert.equal(await Room.exists({ roomName: fresh }), null, 'no room was created')

    // existing room: create-or-get still works, reads and writes still work
    const again = await request(app).post('/api/rooms').send({ roomName: existing })
    assert.equal(again.status, 200)
    assert.equal(again.body.created, false)
    assert.equal((await request(app).get(`/api/rooms/${existing}`)).body.room.content, 'keep me')
    assert.equal((await request(app).put(`/api/rooms/${existing}`).send({ content: 'still writable' })).status, 200)
    assert.deepEqual(await counts(), before, 'the guard never deletes or adds data')
    await app.locals.collab.shutdown()
    await open.locals.collab.shutdown()
  })

  it('REST: when the guard allows, new rooms are created normally; health shows only a coarse state', async () => {
    const app = createApp({ storageGuard: new StorageGuard({ limitMb: 512, thresholdRatio: 0.8, ...quiet }) })
    assert.equal((await request(app).post('/api/rooms').send({ roomName: name() })).status, 201)
    const health = (await request(app).get('/api/health')).body
    assert.equal(health.storage.guard, 'ok')
    assert.equal(health.storage.source, 'cluster', 'a real MongoDB lets listDatabases succeed')
    assert.ok(!JSON.stringify(health.storage).match(/\d/), 'health exposes no sizes')
    await app.locals.collab.shutdown()
  })

  it('WebSocket: a NEW room is closed with 4409 and not created; an EXISTING room still connects and syncs', async () => {
    const existing = name()
    const s = await startServer({ manager: { storageGuard: refusing } })
    cleanups.push(() => s.stop().catch(() => {}))
    await Room.create({ roomName: existing, content: 'already here', language: 'plaintext' })
    const before = await counts()

    const fresh = name()
    assert.equal(await rawSocket(s, `/ws/${fresh}`).closed, 4409)
    assert.equal(await Room.exists({ roomName: fresh }), null, 'refused room was not created')

    const c = connectClient(s, existing)
    cleanups.push(async () => c.destroy())
    await c.ready()
    assert.equal(c.value, 'already here')
    c.text.insert(c.text.length, ' + edit')
    await waitFor(async () => (await Room.findOne({ roomName: existing })).content === 'already here + edit', { label: 'existing room still persists edits' })
    assert.equal((await counts()).rooms, before.rooms, 'no room was added or removed')
  })

  it('4409 is a permanent close code (clients stop retrying) and carries no data loss', async () => {
    const s = await startServer({ manager: { storageGuard: refusing } })
    cleanups.push(() => s.stop().catch(() => {}))
    const c = connectClient(s, name())
    cleanups.push(async () => c.destroy())
    await waitFor(() => c.closes.includes(4409), { label: 'client sees 4409' })
    await sleep(400)
    assert.equal(c.closes.filter((x) => x === 4409).length, 1, 'no reconnect loop after a permanent close')
  })
})
