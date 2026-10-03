// Smoke test against the REAL MongoDB Atlas cluster from backend/.env.
// ISOLATION: connects ONLY to the separate "dropdrop_test" database (see atlas-guard.js); the real "dropdrop"
// database is never touched. Skipped (not passed) unless MONGODB_URI is a real connection string.
// It never uses mongodb-memory-server, never prints the URI, and deletes the one uniquely named room it creates
// (and that room's update log). Run: npm run test:atlas
import 'dotenv/config'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { disconnectDatabase } from '../src/config/database.js'
import Room from '../src/models/Room.js'
import RoomUpdate from '../src/models/RoomUpdate.js'
import { REAL_DB, TEST_DB, atlasConfigured, connectTestDatabase } from './atlas-guard.js'

const uri = process.env.MONGODB_URI
const configured = atlasConfigured(uri)
const skip = configured ? false : 'SKIPPED: MONGODB_URI in backend/.env is missing or still a placeholder'
const room = `atlas-smoke-${Date.now()}`

describe('MongoDB Atlas (real cluster, isolated test database)', { skip }, () => {
  let app
  before(async () => {
    await connectTestDatabase(uri)
    app = createApp()
  })
  after(async () => {
    if (!configured) return
    if (mongoose.connection.readyState !== 1) await connectTestDatabase(uri)
    await RoomUpdate.deleteMany({ roomName: room })
    await Room.deleteOne({ roomName: room })
    assert.equal((await Room.countDocuments({ roomName: room })) + (await RoomUpdate.countDocuments({ roomName: room })), 0, 'test data was not cleaned up')
    await app.locals.collab.shutdown()
    await disconnectDatabase()
  })

  it(`is connected to Atlas (not local/in-memory) and ONLY to "${TEST_DB}", never "${REAL_DB}"`, () => {
    assert.equal(mongoose.connection.name, TEST_DB)
    assert.notEqual(mongoose.connection.name, REAL_DB)
    assert.match(mongoose.connection.host, /\.mongodb\.net$/)
    assert.equal(mongoose.connection.readyState, 1)
  })

  it('creates, retrieves and updates a room through the API', async () => {
    assert.equal((await request(app).get('/api/health')).body.database, 'connected')
    assert.equal((await request(app).post('/api/rooms').send({ roomName: room })).status, 201)
    assert.equal((await request(app).get(`/api/rooms/${room}`)).body.room.content, '')
    const put = await request(app).put(`/api/rooms/${room}`).send({ content: 'stored in atlas', language: 'python' })
    assert.equal(put.status, 200)
  })

  it('content persists after fully disconnecting and reconnecting (still the test database)', async () => {
    await app.locals.collab.shutdown() // flush + snapshot
    await disconnectDatabase()
    assert.notEqual(mongoose.connection.readyState, 1)
    await connectTestDatabase(uri) // the guard again: reconnecting must not fall back to the URI's own database
    const res = await request(createApp()).get(`/api/rooms/${room}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.room.content, 'stored in atlas')
    assert.equal(res.body.room.language, 'python')
    assert.equal(mongoose.connection.name, TEST_DB)
  })
})
