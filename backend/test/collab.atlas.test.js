// Collaboration persistence against the REAL MongoDB Atlas cluster from backend/.env.
// Isolation: uses the separate database "dropdrop_test" (never "dropdrop") and uniquely named rooms,
// and deletes only the rooms it created. Skipped (not passed) if .env is missing or a placeholder.
// No mongodb-memory-server here. Credentials are never printed. Run: npm run test:atlas
import 'dotenv/config'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import request from 'supertest'
import { disconnectDatabase } from '../src/config/database.js'
import { TEST_DB, atlasConfigured, connectTestDatabase } from './atlas-guard.js'
import Room from '../src/models/Room.js'
import RoomUpdate from '../src/models/RoomUpdate.js'
import { connectClient, startServer, waitFor } from './collab-helpers.js'

const uri = process.env.MONGODB_URI
const configured = atlasConfigured(uri)
const skip = configured ? false : 'SKIPPED: MONGODB_URI in backend/.env is missing or still a placeholder'
const prefix = `atlas-collab-${Date.now()}`
let n = 0
const room = () => `${prefix}-${++n}`
const T = { timeout: 20_000, label: 'atlas' }

describe('Collaboration persistence on MongoDB Atlas (database "dropdrop_test")', { skip }, () => {
  const live = []
  before(async () => {
    await connectTestDatabase(uri)
    assert.equal(mongoose.connection.name, TEST_DB)
    assert.match(mongoose.connection.host, /\.mongodb\.net$/)
  })
  after(async () => {
    for (const x of live.splice(0)) await x().catch(() => {})
    if (!configured) return
    const rooms = { roomName: { $regex: `^${prefix}-` } }
    await RoomUpdate.deleteMany(rooms)
    await Room.deleteMany(rooms)
    assert.equal(await Room.countDocuments(rooms) + (await RoomUpdate.countDocuments(rooms)), 0, 'test data not cleaned up')
    await disconnectDatabase()
  })

  const server = async (opts) => {
    const s = await startServer(opts)
    live.push(() => s.stop())
    return s
  }
  const client = (s, r) => {
    const c = connectClient(s, r)
    live.push(async () => c.destroy())
    return c
  }

  it('two clients collaborate and the result is persisted in Atlas', async () => {
    const s = await server()
    const r = room()
    const a = await client(s, r).ready()
    const b = await client(s, r).ready()
    a.text.insert(0, 'from A ')
    await waitFor(() => b.value === 'from A ', T)
    b.text.insert(b.text.length, 'and B')
    await waitFor(() => a.value === 'from A and B', T)
    await waitFor(async () => (await Room.findOne({ roomName: r }))?.content === 'from A and B', { ...T, label: 'Room.content in Atlas' })
    assert.ok((await RoomUpdate.countDocuments({ roomName: r })) >= 1)
  })

  it('concurrent offline edits from two clients merge and persist', async () => {
    const s = await server()
    const r = room()
    const a = await client(s, r).ready()
    const b = await client(s, r).ready()
    a.text.insert(0, 'base')
    await waitFor(() => b.value === 'base', T)
    a.provider.disconnect(); b.provider.disconnect()
    a.text.insert(0, 'A-')
    b.text.insert(b.text.length, '-B')
    a.provider.connect(); b.provider.connect()
    await waitFor(() => a.value === b.value && a.value.includes('A-') && a.value.includes('-B'), T)
    await waitFor(async () => (await Room.findOne({ roomName: r })).content === a.value, T)
  })

  it('clean restart: a new server process restores the room from Atlas', async () => {
    const r = room()
    const s1 = await startServer()
    const a = connectClient(s1, r)
    await a.ready()
    a.text.insert(0, 'survives a restart')
    a.meta.set('language', 'rust')
    await waitFor(() => s1.collab.get(r).ytext.toString() === 'survives a restart', T)
    a.destroy()
    await s1.stop()
    assert.ok((await Room.findOne({ roomName: r }).select('+yjsState')).yjsState?.length > 0, 'snapshot stored')
    const s2 = await server()
    const b = await client(s2, r).ready()
    assert.equal(b.value, 'survives a restart')
    assert.equal(b.meta.get('language'), 'rust')
  })

  it('crash (no flush/snapshot): recovered from the update log in Atlas', async () => {
    const r = room()
    const s1 = await startServer()
    const a = connectClient(s1, r)
    await a.ready()
    a.text.insert(0, 'logged before crash')
    await waitFor(async () => (await Room.findOne({ roomName: r })).content === 'logged before crash', T)
    a.destroy()
    await s1.crash()
    const s2 = await server()
    assert.equal((await client(s2, r).ready()).value, 'logged before crash')
  })

  it('a Phase 2 room (plain content in Atlas) is migrated into Yjs without data loss', async () => {
    const s = await server()
    const r = room()
    await Room.create({ roomName: r, content: 'legacy phase 2 text', language: 'python' })
    const a = await client(s, r).ready()
    assert.equal(a.value, 'legacy phase 2 text')
    assert.equal(a.meta.get('language'), 'python')
    assert.ok((await Room.findOne({ roomName: r }).select('+yjsState')).yjsState?.length > 0)
    assert.equal((await client(s, r).ready()).value, 'legacy phase 2 text')
  })

  it('REST PUT does not overwrite newer collaborative state', async () => {
    const s = await server()
    const r = room()
    await request(s.httpUrl).post('/api/rooms').send({ roomName: r })
    const a = await client(s, r).ready()
    a.text.insert(0, 'hello world')
    await waitFor(() => s.collab.get(r).ytext.toString() === 'hello world', T)
    a.provider.disconnect()
    a.text.insert(0, '>> ')
    assert.equal((await request(s.httpUrl).put(`/api/rooms/${r}`).send({ content: 'hello there world' })).status, 200)
    a.provider.connect()
    await waitFor(() => a.value === '>> hello there world', T)
    await waitFor(async () => (await Room.findOne({ roomName: r })).content === '>> hello there world', T)
  })

  it('a large (400 KB) document persists and reloads correctly', async () => {
    const r = room()
    const big = 'line of text for the large document\n'.repeat(11_400) // ~410 KB
    const s1 = await startServer()
    const a = connectClient(s1, r)
    await a.ready()
    a.text.insert(0, big)
    await waitFor(() => s1.collab.get(r).ytext.length === big.length, T)
    a.destroy()
    await s1.stop()
    const s2 = await server()
    assert.equal((await client(s2, r).ready()).value.length, big.length)
  })
})
