// Real-time collaboration tests: real WebSocket server + real y-websocket clients.
// Persistence here uses a throwaway in-memory MongoDB (fast, deterministic). The same persistence
// guarantees are verified against the real Atlas cluster in collab.atlas.test.js.
import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import Room from '../src/models/Room.js'
import RoomUpdate from '../src/models/RoomUpdate.js'
import { MSG_PERSISTED } from '../src/collab/protocol.js'
import { ORIGIN, connectClient, rawSocket, sleep, startServer, waitFor } from './collab-helpers.js'
import * as decoding from 'lib0/decoding'
import request from 'supertest'

let mongod
let n = 0
const room = (p = 'room') => `${p}-${process.pid}-${++n}`
const cleanups = []
const track = (c) => (cleanups.push(c), c)

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

async function server(opts) {
  const s = await startServer(opts)
  track(() => s.stop().catch(() => {}))
  return s
}
function mk(s, r, o) {
  const c = connectClient(s, r, o)
  cleanups.push(() => c.destroy())
  return c
}

describe('connection and sync', () => {
  it('1. a client connects over WebSocket and syncs', async () => {
    const s = await server()
    const a = mk(s, room())
    await a.ready()
    assert.equal(a.provider.wsconnected, true)
    assert.equal(a.provider.synced, true)
  })

  it('2-4. two clients share a room: A→B, B→A', async () => {
    const s = await server()
    const r = room()
    const a = await mk(s, r).ready()
    const b = await mk(s, r).ready()
    a.text.insert(0, 'hello from A')
    await waitFor(() => b.value === 'hello from A', { label: 'B receives A' })
    b.text.insert(b.text.length, ' + B')
    await waitFor(() => a.value === 'hello from A + B', { label: 'A receives B' })
  })

  it('a late joiner receives existing content', async () => {
    const s = await server()
    const r = room()
    const a = await mk(s, r).ready()
    a.text.insert(0, 'already here')
    await waitFor(() => s.collab.get(r).ytext.toString() === 'already here')
    const b = await mk(s, r).ready()
    assert.equal(b.value, 'already here')
  })

  it('5. concurrent edits from both clients converge without losing either', async () => {
    const s = await server()
    const r = room()
    const a = await mk(s, r).ready()
    const b = await mk(s, r).ready()
    a.text.insert(0, 'base')
    await waitFor(() => b.value === 'base')
    // Truly concurrent: both edit while disconnected from each other, then reconnect.
    a.provider.disconnect()
    b.provider.disconnect()
    a.text.insert(0, 'AAA-')
    b.text.insert(b.text.length, '-BBB')
    a.text.insert(a.text.length, '!a')
    b.text.insert(0, 'b!')
    a.provider.connect()
    b.provider.connect()
    await waitFor(() => a.value === b.value && a.value.includes('AAA-') && a.value.includes('-BBB') && a.value.includes('!a') && a.value.includes('b!'), { label: 'convergence' })
    await waitFor(() => s.collab.get(r).ytext.toString() === a.value, { label: 'server converged' })
  })

  it('5b. rapid interleaved typing from several clients converges', async () => {
    const s = await server()
    const r = room()
    const cs = await Promise.all([0, 1, 2].map(() => mk(s, r).ready()))
    for (let i = 0; i < 40; i++) cs.forEach((c, k) => c.text.insert(Math.min(c.text.length, i), String(k)))
    await waitFor(() => cs.every((c) => c.value === cs[0].value) && cs[0].text.length === 120, { label: 'all 120 chars everywhere' })
  })

  it('6. rooms are isolated from each other', async () => {
    const s = await server()
    const r1 = room('iso'), r2 = room('iso')
    const a = await mk(s, r1).ready()
    const b = await mk(s, r2).ready()
    a.text.insert(0, 'secret of room one')
    b.text.insert(0, 'room two text')
    await waitFor(() => s.collab.get(r1).ytext.toString() === 'secret of room one' && s.collab.get(r2).ytext.toString() === 'room two text')
    await sleep(100)
    assert.equal(a.value, 'secret of room one')
    assert.equal(b.value, 'room two text')
    const late = await mk(s, r2).ready()
    assert.equal(late.value, 'room two text')
  })

  it('language is shared through the Yjs doc', async () => {
    const s = await server()
    const r = room()
    const a = await mk(s, r).ready()
    const b = await mk(s, r).ready()
    a.meta.set('language', 'python')
    await waitFor(() => b.meta.get('language') === 'python')
    await waitFor(async () => (await Room.findOne({ roomName: r }))?.language === 'python', { label: 'language mirrored to Room' })
  })
})

describe('persistence', () => {
  it('7. updates are persisted to MongoDB (log + plain-text mirror)', async () => {
    const s = await server()
    const r = room()
    const a = await mk(s, r).ready()
    a.text.insert(0, 'persist me ✓')
    await waitFor(async () => (await Room.findOne({ roomName: r })).content === 'persist me ✓', { label: 'Room.content mirror' })
    assert.ok((await RoomUpdate.countDocuments({ roomName: r })) >= 1)
  })

  it('7b. batches keystrokes: far fewer DB writes than updates', async () => {
    const s = await server({ manager: { flushIntervalMs: 200, compactEvery: 1000 } })
    const r = room()
    const a = await mk(s, r).ready()
    for (let i = 0; i < 200; i++) a.text.insert(a.text.length, 'x')
    await waitFor(async () => (await Room.findOne({ roomName: r })).content.length === 200)
    const writes = await RoomUpdate.countDocuments({ roomName: r })
    assert.ok(writes <= 10, `expected batched writes, got ${writes} for 200 keystrokes`)
  })

  it('7c. compaction folds the log into a snapshot without changing content', async () => {
    const s = await server({ manager: { compactEvery: 3 } })
    const r = room()
    const a = await mk(s, r).ready()
    for (let i = 0; i < 8; i++) {
      a.text.insert(a.text.length, `line${i}\n`)
      await waitFor(async () => (await Room.findOne({ roomName: r })).content === a.value)
    }
    await waitFor(async () => (await Room.findOne({ roomName: r }).select('+yjsState')).yjsState?.length > 0 && (await RoomUpdate.countDocuments({ roomName: r })) < 3, { label: 'snapshot written, log trimmed' })
    const b = await mk(s, r).ready()
    assert.equal(b.value, a.value)
  })

  it('8. clients recover after the WebSocket drops and reconnects (edits made while offline merge)', async () => {
    const s = await server()
    const r = room()
    const a = await mk(s, r).ready()
    const b = await mk(s, r).ready()
    a.text.insert(0, 'one ')
    await waitFor(() => b.value === 'one ')
    // Server-side drop of every socket: clients must reconnect on their own.
    for (const ws of s.wsApi.wss.clients) ws.terminate()
    await waitFor(() => !a.provider.wsconnected, { label: 'A notices drop' })
    a.text.insert(a.text.length, 'two ') // offline edit
    await waitFor(() => a.provider.wsconnected && a.provider.synced && b.provider.wsconnected && b.provider.synced, { label: 'auto-reconnect' })
    b.text.insert(b.text.length, 'three')
    await waitFor(() => a.value === b.value && a.value.includes('two') && a.value.includes('three'), { label: 'merged after reconnect' })
  })

  it('9. clean server restart: content is restored from MongoDB', async () => {
    const r = room()
    const s1 = await startServer()
    const a = connectClient(s1, r)
    await a.ready()
    a.text.insert(0, 'survives restart')
    a.meta.set('language', 'rust')
    await waitFor(() => s1.collab.get(r).ytext.toString() === 'survives restart')
    a.destroy()
    await s1.stop() // flushes + snapshots
    const s2 = await server()
    const b = await mk(s2, r).ready()
    assert.equal(b.value, 'survives restart')
    assert.equal(b.meta.get('language'), 'rust')
  })

  it('9b. crash (no flush/snapshot): state is recovered from the update log', async () => {
    const r = room()
    const s1 = await startServer()
    const a = connectClient(s1, r)
    await a.ready()
    a.text.insert(0, 'logged before crash')
    await waitFor(async () => (await Room.findOne({ roomName: r })).content === 'logged before crash')
    a.destroy()
    await s1.crash()
    const s2 = await server()
    const b = await mk(s2, r).ready()
    assert.equal(b.value, 'logged before crash')
  })

  it('9c. client offline edits made during a server outage sync after the server returns', async () => {
    const r = room()
    const s1 = await startServer()
    const a = connectClient(s1, r)
    await a.ready()
    a.text.insert(0, 'before ')
    await waitFor(() => s1.collab.get(r).ytext.toString() === 'before ')
    await s1.stop()
    a.text.insert(a.text.length, 'during-outage ')
    const s2 = await startServer({ port: s1.port }) // a restart keeps its address
    track(() => s2.stop())
    await waitFor(() => a.provider.wsconnected && a.provider.synced, { label: 'client auto-reconnects to restarted server' })
    const b = await mk(s2, r).ready()
    await waitFor(() => b.value === 'before during-outage ', { label: 'B sees outage edits' })
    a.destroy()
  })

  it('13a. server sends persistence acks that cover the client\'s edits', async () => {
    const s = await server()
    const r = room()
    const a = await mk(s, r, { params: { 'persisted-ack': '1' } }).ready()
    let ack = null
    a.provider.messageHandlers[MSG_PERSISTED] = (_enc, dec) => {
      ack = Y.decodeStateVector(decoding.readVarUint8Array(dec))
    }
    a.text.insert(0, 'ack me')
    const local = Y.decodeStateVector(Y.encodeStateVector(a.doc))
    await waitFor(() => ack && [...local].every(([id, clock]) => (ack.get(id) ?? 0) >= clock), { label: 'persisted ack' })
  })

  it('13b. cleanup: idle docs are persisted and freed; presence disappears on disconnect', async () => {
    const s = await server()
    const r = room()
    const a = await mk(s, r).ready()
    const b = await mk(s, r).ready()
    a.provider.awareness.setLocalStateField('user', { name: 'Anon A' })
    await waitFor(() => [...b.provider.awareness.getStates().values()].some((st) => st.user?.name === 'Anon A'), { label: 'B sees A presence' })
    a.text.insert(0, 'bye')
    a.destroy()
    await waitFor(() => ![...b.provider.awareness.getStates().values()].some((st) => st.user?.name === 'Anon A'), { label: 'A presence removed' })
    b.destroy()
    await waitFor(() => !s.collab.loadedRooms().includes(r), { label: 'doc freed after grace period' })
    assert.equal(s.wsApi.connectionCount(), 0)
    assert.equal((await Room.findOne({ roomName: r })).content, 'bye')
  })
})

describe('REST / Phase 2 compatibility', () => {
  it('a Phase 2 room (plain content, no Yjs state) is migrated on first connect', async () => {
    const s = await server()
    const r = room('legacy')
    await Room.create({ roomName: r, content: 'written in phase 2', language: 'python' })
    assert.equal((await Room.findOne({ roomName: r }).select('+yjsState')).yjsState, null)
    const a = await mk(s, r).ready()
    assert.equal(a.value, 'written in phase 2')
    assert.equal(a.meta.get('language'), 'python')
    assert.ok((await Room.findOne({ roomName: r }).select('+yjsState')).yjsState?.length > 0)
    // and a second client does not duplicate the migrated text
    const b = await mk(s, r).ready()
    assert.equal(b.value, 'written in phase 2')
  })

  it('REST PUT merges into the live document instead of overwriting it', async () => {
    const s = await server()
    const r = room()
    await request(s.httpUrl).post('/api/rooms').send({ roomName: r })
    const a = await mk(s, r).ready()
    a.text.insert(0, 'hello world')
    await waitFor(() => s.collab.get(r).ytext.toString() === 'hello world')
    // Deterministic concurrency: A edits the START while offline; REST replaces the MIDDLE meanwhile.
    a.provider.disconnect()
    a.text.insert(0, '>> ')
    const put = await request(s.httpUrl).put(`/api/rooms/${r}`).send({ content: 'hello there world' })
    assert.equal(put.status, 200)
    assert.equal(s.collab.get(r).ytext.toString(), 'hello there world')
    a.provider.connect()
    await waitFor(() => a.value === '>> hello there world', { label: 'offline edit and REST edit both survive' })
    await waitFor(() => s.collab.get(r).ytext.toString() === '>> hello there world')
  })

  it('REST PUT is broadcast to connected clients in real time', async () => {
    const s = await server()
    const r = room()
    await request(s.httpUrl).post('/api/rooms').send({ roomName: r })
    const a = await mk(s, r).ready()
    await request(s.httpUrl).put(`/api/rooms/${r}`).send({ content: 'from REST', language: 'go' })
    await waitFor(() => a.value === 'from REST' && a.meta.get('language') === 'go', { label: 'live client sees REST edit' })
  })

  it('REST GET reflects live edits that are not yet flushed', async () => {
    const s = await server({ manager: { flushIntervalMs: 60_000 } })
    const r = room()
    await request(s.httpUrl).post('/api/rooms').send({ roomName: r })
    const a = await mk(s, r).ready()
    a.text.insert(0, 'live only')
    await waitFor(() => s.collab.get(r).ytext.toString() === 'live only')
    assert.equal((await request(s.httpUrl).get(`/api/rooms/${r}`)).body.room.content, 'live only')
  })
})

describe('validation, abuse protection and limits', () => {
  it('10. invalid room names are closed with 4400', async () => {
    const s = await server()
    for (const path of ['/ws/bad%20name', '/ws/-start', `/ws/${'a'.repeat(65)}`, '/ws/', '/ws/%E0%A4%A', '/ws/a.b']) {
      const ws = rawSocket(s, path)
      assert.equal(await ws.closed, 4400, path)
    }
  })

  it('10b. browsers from a foreign Origin are refused (4403); no-Origin clients are allowed', async () => {
    const s = await server()
    assert.equal(await rawSocket(s, '/ws/okroom', { headers: { Origin: 'http://evil.example' } }).closed, 4403)
    const ok = rawSocket(s, '/ws/okroom', { headers: { Origin: ORIGIN } })
    await ok.opened
    await sleep(100)
    assert.equal(ok.readyState, 1)
    ok.close()
  })

  it('11. malformed messages close only that socket and never crash the server', async () => {
    const s = await server()
    const r = room()
    const good = await mk(s, r).ready()
    good.text.insert(0, 'still fine')
    const bad = [
      Buffer.from([]), // empty
      Buffer.from([255, 255, 255, 255, 255, 255, 255, 255, 255, 255]), // varuint overflow
      Buffer.from([99]), // unknown message type
      Buffer.from([0]), // sync, truncated
      Buffer.from([0, 2, 5, 1, 2]), // sync update claiming 5 bytes, has 2
      Buffer.from([0, 2, 3, 9, 9, 9]), // sync update with garbage Yjs payload
      Buffer.from([1, 4, 1, 2, 3, 4]), // awareness with garbage payload
    ]
    for (const payload of bad) {
      const ws = rawSocket(s, `/ws/${r}`)
      await ws.opened
      ws.send(payload)
      assert.equal(await ws.closed, 4401, `payload ${[...payload].join(',')}`)
    }
    const text = rawSocket(s, `/ws/${r}`)
    await text.opened
    text.send('i am text, not binary')
    assert.equal(await text.closed, 4401)
    await sleep(50)
    assert.equal(good.provider.wsconnected, true)
    assert.equal(good.value, 'still fine')
    const late = await mk(s, r).ready()
    assert.equal(late.value, 'still fine')
  })

  it('12a. oversized update is rejected (4413) and not applied', async () => {
    const s = await server({ manager: { maxUpdateBytes: 2000 } })
    const r = room()
    const spy = await mk(s, r).ready()
    const a = mk(s, r)
    await a.ready()
    a.text.insert(0, 'x'.repeat(5000))
    await waitFor(() => a.closes.includes(4413), { label: 'close 4413' })
    await sleep(100)
    assert.equal(spy.value, '')
    assert.equal(s.collab.get(r).ytext.length, 0)
  })

  it('12b. document length limit is enforced server-side', async () => {
    const s = await server({ manager: { maxContentLength: 1000 } })
    const r = room()
    const a = await mk(s, r).ready()
    a.text.insert(0, 'y'.repeat(900))
    await waitFor(() => s.collab.get(r).ytext.length === 900)
    const b = await mk(s, r).ready()
    b.text.insert(0, 'z'.repeat(200)) // would make 1100
    await waitFor(() => b.closes.includes(4413), { label: 'close 4413 for over-limit' })
    assert.equal(s.collab.get(r).ytext.length, 900)
    a.text.insert(0, 'ok') // other clients unaffected
    await waitFor(() => s.collab.get(r).ytext.length === 902)
  })

  it('12c. per-connection message rate limit closes flooders with 4429', async () => {
    const s = await server({ ws: { messageBurst: 10, messagesPerSecond: 1 } })
    const ws = rawSocket(s, `/ws/${room()}`)
    await ws.opened
    for (let i = 0; i < 50; i++) ws.send(Buffer.from([3])) // valid query-awareness messages
    assert.equal(await ws.closed, 4429)
  })

  it('12d. connection limits: per IP and per room', async () => {
    const s = await server({ ws: { maxConnectionsPerIp: 2 } })
    const r = room()
    const w1 = rawSocket(s, `/ws/${r}`), w2 = rawSocket(s, `/ws/${r}`)
    await Promise.all([w1.opened, w2.opened])
    await sleep(100)
    assert.equal(await rawSocket(s, `/ws/${r}`).closed, 1013)
    w1.close(); w2.close()

    const s2 = await server({ ws: { maxClientsPerRoom: 2 } })
    const r2 = room()
    const c1 = rawSocket(s2, `/ws/${r2}`), c2 = rawSocket(s2, `/ws/${r2}`)
    await Promise.all([c1.opened, c2.opened])
    await sleep(150)
    assert.equal(await rawSocket(s2, `/ws/${r2}`).closed, 1013)
    c1.close(); c2.close()
  })

  it('12e. new-connection rate limit per IP', async () => {
    const s = await server({ ws: { newConnectionsPerMinutePerIp: 3 } })
    const codes = []
    for (let i = 0; i < 5; i++) {
      const w = rawSocket(s, `/ws/${room()}`)
      await w.opened
      w.close()
      codes.push(await w.closed)
    }
    const blocked = rawSocket(s, `/ws/${room()}`)
    assert.equal(await blocked.closed, 4429)
  })
})

describe('client identity behind a trusted proxy (X-Forwarded-For is client-controlled)', () => {
  const xff = (v) => ({ 'X-Forwarded-For': v })

  it('forged leading entries cannot dodge the per-IP connection limit', async () => {
    const s = await server({ ws: { maxConnectionsPerIp: 2, trustProxyHops: 1 } })
    const r = room()
    const w1 = rawSocket(s, `/ws/${r}`, { headers: xff('1.1.1.1, 198.51.100.7') })
    const w2 = rawSocket(s, `/ws/${r}`, { headers: xff('2.2.2.2, 198.51.100.7') })
    await Promise.all([w1.opened, w2.opened])
    await sleep(150)
    // a third connection with yet another forged prefix is still the same real client
    assert.equal(await rawSocket(s, `/ws/${r}`, { headers: xff('3.3.3.3, 198.51.100.7') }).closed, 1013)
    w1.close(); w2.close()
  })

  it('different real clients (different rightmost entries) are counted separately', async () => {
    const s = await server({ ws: { maxConnectionsPerIp: 1, trustProxyHops: 1 } })
    const r = room()
    const socks = ['198.51.100.1', '198.51.100.2', '198.51.100.3'].map((ip) => rawSocket(s, `/ws/${r}`, { headers: xff(`9.9.9.9, ${ip}`) }))
    await Promise.all(socks.map((w) => w.opened))
    await sleep(200)
    assert.ok(socks.every((w) => w.readyState === 1), 'each real client may hold its own connection')
    socks.forEach((w) => w.close())
  })

  it('without trusted proxies the header is ignored (forging it changes nothing)', async () => {
    const s = await server({ ws: { maxConnectionsPerIp: 2 } }) // trustProxyHops defaults to 0
    const r = room()
    const w1 = rawSocket(s, `/ws/${r}`, { headers: xff('1.1.1.1') })
    const w2 = rawSocket(s, `/ws/${r}`, { headers: xff('2.2.2.2') })
    await Promise.all([w1.opened, w2.opened])
    await sleep(150)
    assert.equal(await rawSocket(s, `/ws/${r}`, { headers: xff('3.3.3.3') }).closed, 1013)
    w1.close(); w2.close()
  })

  it('the legacy boolean trustProxy option still means exactly one trusted proxy', async () => {
    const s = await server({ ws: { maxConnectionsPerIp: 1, trustProxy: true } })
    const r = room()
    const a = rawSocket(s, `/ws/${r}`, { headers: xff('1.1.1.1, 198.51.100.1') })
    await a.opened
    await sleep(100)
    assert.equal(await rawSocket(s, `/ws/${r}`, { headers: xff('2.2.2.2, 198.51.100.1') }).closed, 1013)
    const b = rawSocket(s, `/ws/${r}`, { headers: xff('2.2.2.2, 198.51.100.2') })
    await b.opened
    a.close(); b.close()
  })
})

describe('rolling deploy: two server instances overlap on the same database', () => {
  const instance = async () => {
    const s = await startServer()
    cleanups.push(() => s.stop().catch(() => {}))
    return s
  }
  const loadFresh = async (r) => {
    const s = await instance()
    const c = await mk(s, r).ready()
    return c.value
  }

  it('an instance compacting never deletes log entries written by the OTHER instance', async () => {
    const r = room()
    const s1 = await instance() // "old" instance
    const s2 = await instance() // "new" instance
    const a = await mk(s1, r).ready()
    const b = await mk(s2, r).ready() // both loaded the (empty) room before anyone wrote
    b.text.insert(0, 'BBB ')
    await waitFor(async () => (await Room.findOne({ roomName: r })).content.includes('BBB'), { label: 'B persisted' })
    a.text.insert(0, 'AAA ') // written later, so its log entry has the newer id
    await waitFor(async () => (await Room.findOne({ roomName: r })).content.includes('AAA'), { label: 'A persisted' })
    a.destroy()
    await s1.stop() // old instance compacts on shutdown; old code deleted every log entry up to its newest id
    const seen = await loadFresh(r) // a brand-new instance reads only what is in MongoDB
    assert.ok(seen.includes('AAA') && seen.includes('BBB'), `data lost: "${seen}"`)
  })

  it('an older instance can never overwrite a newer snapshot (snapshots are merged, not replaced)', async () => {
    const r = room()
    const s1 = await instance() // will compact LAST, with an older view of the document
    const s2 = await instance()
    const a = await mk(s1, r).ready()
    const b = await mk(s2, r).ready()
    b.text.insert(0, 'only-on-s2')
    await waitFor(async () => (await Room.findOne({ roomName: r })).content === 'only-on-s2', { label: 'B persisted' })
    b.destroy()
    await s2.stop() // newer instance writes its snapshot and removes its own log entries
    a.text.insert(0, 'from-s1 ')
    await waitFor(async () => (await Room.findOne({ roomName: r })).content.includes('from-s1'), { label: 'A persisted' })
    a.destroy()
    await s1.stop() // older instance now compacts; a blind overwrite would drop "only-on-s2" for good
    const seen = await loadFresh(r)
    assert.ok(seen.includes('only-on-s2') && seen.includes('from-s1'), `data lost: "${seen}"`)
  })

  it('two instances migrating the same Phase 2 room at once do not duplicate its text', async () => {
    for (let i = 0; i < 6; i++) {
      const r = room('legacy')
      await Room.create({ roomName: r, content: 'legacy text', language: 'python' })
      const s1 = await instance()
      const s2 = await instance()
      const [e1, e2] = await Promise.all([s1.collab.acquire(r), s2.collab.acquire(r)]) // both load an un-migrated room together
      assert.equal(e1.ytext.toString(), 'legacy text')
      assert.equal(e2.ytext.toString(), 'legacy text')
      // An edit made through the SECOND instance is persisted against ITS copy of the migrated text. If that copy
      // were an independent insert (no atomic claim), the edit would reference structures that do not exist in
      // the stored snapshot and would silently vanish (or the text would double) on the next load.
      await s2.collab.applyRest(r, { content: 'legacy EDITED text' })
      await s2.collab.flushRoom(r)
      s1.collab.release(e1)
      s2.collab.release(e2)
      assert.equal(await loadFresh(r), 'legacy EDITED text', 'a later load must see the text exactly once, with the edit applied')
    }
  })
})

// F2: the persistence interval is configurable (default 1000 ms). These tests prove durability and recovery at the
// 2-3 s values proposed for the free Atlas tier, and document the data-loss window explicitly.
for (const interval of [2000, 3000]) {
  describe(`persistence interval ${interval} ms: durability and recovery`, () => {
    const inst = async (opts = {}) => {
      const s = await startServer({ manager: { flushIntervalMs: interval }, ...opts })
      cleanups.push(() => s.stop().catch(() => {}))
      return s
    }
    const fresh = async (r) => {
      const s = await inst()
      return (await mk(s, r).ready()).value
    }

    it('a clean shutdown flushes everything immediately: no edit is lost even inside the window', async () => {
      const r = room('dur')
      const s = await inst()
      const c = await mk(s, r).ready()
      c.text.insert(0, 'typed just before shutdown')
      await waitFor(() => s.collab.get(r).ytext.toString() === 'typed just before shutdown', { label: 'server has the edit (not yet flushed)' })
      c.destroy()
      await s.stop() // SIGTERM path: flush + snapshot
      assert.equal(await fresh(r), 'typed just before shutdown')
    })

    it('the "saved" acknowledgement is only sent after the write, i.e. about one interval later (never early)', async () => {
      const r = room('dur')
      const s = await inst()
      const c = await mk(s, r, { params: { 'persisted-ack': '1' } }).ready()
      let acked = false
      const t0 = Date.now()
      c.provider.messageHandlers[10] = () => { acked = true }
      c.text.insert(0, 'ack timing')
      await sleep(interval * 0.5)
      assert.equal(acked, false, 'must not claim "saved" before the write happens')
      await waitFor(() => acked, { timeout: interval + 3000, label: 'persisted ack' })
      const elapsed = Date.now() - t0
      assert.ok(elapsed >= interval * 0.7, `ack came too early (${elapsed} ms)`)
      assert.ok(elapsed <= interval + 2500, `ack came too late (${elapsed} ms)`)
      assert.equal((await Room.findOne({ roomName: r })).content, 'ack timing', 'the ack really means it is stored')
    })

    it('crash while a client is still connected: the client re-sends on reconnect, so nothing is lost', async () => {
      const r = room('dur')
      const s1 = await startServer({ manager: { flushIntervalMs: interval } })
      const c = mk(s1, r, { maxBackoffTime: 100 })
      await c.ready()
      c.text.insert(0, 'unflushed edit')
      await waitFor(() => s1.collab.get(r).ytext.toString() === 'unflushed edit', { label: 'server received it' })
      await s1.crash() // no flush, no snapshot: the edit exists only in memory and in the client
      const s2 = await startServer({ manager: { flushIntervalMs: interval }, port: s1.port })
      cleanups.push(() => s2.stop().catch(() => {}))
      await waitFor(() => c.provider.wsconnected && c.provider.synced, { timeout: 15_000, label: 'client reconnected' })
      // The edit came back from the client's memory; it is safely on disk once the restarted server's next write happens.
      await waitFor(async () => (await Room.findOne({ roomName: r })).content === 'unflushed edit', { timeout: interval + 5000, label: 'restarted server persisted it' })
      assert.equal(await fresh(r), 'unflushed edit', 'recovered from the connected client, not from the database')
    })

    it('a client leaving normally never loses data: the server flushes immediately when the last client leaves', async () => {
      const r = room('dur')
      const s1 = await startServer({ manager: { flushIntervalMs: interval } })
      const c = mk(s1, r)
      await c.ready()
      c.text.insert(0, 'baseline')
      await waitFor(async () => (await Room.findOne({ roomName: r })).content === 'baseline', { timeout: interval + 4000, label: 'baseline persisted' })
      c.text.insert(c.text.length, ' + typed then left')
      await waitFor(() => s1.collab.get(r).ytext.toString().includes('typed then left'), { label: 'server received it' })
      c.destroy() // tab closed well inside the interval
      await waitFor(async () => (await Room.findOne({ roomName: r })).content === 'baseline + typed then left', { timeout: 5000, label: 'flushed on leave' })
      await s1.crash() // a crash AFTER the leave cannot lose it
      assert.equal(await fresh(r), 'baseline + typed then left')
    })

    it('DOCUMENTED LOSS WINDOW: lost ONLY if the server crashes while a client holds the edit AND that client never returns', async () => {
      const r = room('dur')
      const s1 = await startServer({ manager: { flushIntervalMs: interval } })
      const c = mk(s1, r)
      await c.ready()
      c.text.insert(0, 'baseline')
      await waitFor(async () => (await Room.findOne({ roomName: r })).content === 'baseline', { timeout: interval + 4000, label: 'baseline persisted' })
      c.text.insert(c.text.length, ' + inside the window')
      await waitFor(() => s1.collab.get(r).ytext.toString().includes('inside the window'), { label: 'server received it' })
      await s1.crash() // sudden crash BEFORE the next write: the edit now exists only in the client's memory
      c.destroy() // ...and that client (tab closed / offline) never comes back to re-send it
      assert.equal(await fresh(r), 'baseline', 'the unflushed edit is lost; everything already written is intact and uncorrupted')
    })

    it('the window is bounded by the interval: an edit older than one interval is always stored', async () => {
      const r = room('dur')
      const s = await inst()
      const c = await mk(s, r).ready()
      c.text.insert(0, 'bounded')
      await sleep(interval + 1500)
      c.destroy()
      await s.crash?.call(s)
      assert.equal(await fresh(r), 'bounded')
    })
  })
}
