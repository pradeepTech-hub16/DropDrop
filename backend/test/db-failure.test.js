// MongoDB connection-failure handling. Needs no database at all.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { DatabaseConfigError, connectDatabase, redact } from '../src/config/database.js'
import '../src/models/Room.js'

describe('database unavailable', () => {
  const app = createApp()

  it('health reports degraded (503) and does not crash', async () => {
    const res = await request(app).get('/api/health')
    assert.equal(res.status, 503)
    assert.equal(res.body.status, 'degraded')
    assert.equal(res.body.database, 'disconnected')
  })

  it('room endpoints answer 503 DATABASE_UNAVAILABLE instead of hanging', async () => {
    const calls = [
      request(app).post('/api/rooms').send({ roomName: 'abc' }),
      request(app).get('/api/rooms/abc'),
      request(app).put('/api/rooms/abc').send({ content: 'x' }),
    ]
    for (const res of await Promise.all(calls)) {
      assert.equal(res.status, 503)
      assert.equal(res.body.error.code, 'DATABASE_UNAVAILABLE')
    }
  })
})

describe('connectDatabase', () => {
  it('rejects a missing URI with setup instructions', async () => {
    await assert.rejects(connectDatabase(undefined), (e) => e instanceof DatabaseConfigError && /\.env/.test(e.message))
  })

  it('rejects the .env.example placeholders without attempting a connection', async () => {
    for (const uri of [
      'your_mongodb_atlas_connection_string',
      'mongodb+srv://appuser:<db_password>@cluster0.example.mongodb.net/dropdrop?appName=Cluster0',
    ]) {
      await assert.rejects(connectDatabase(uri), /not configured/)
    }
  })

  it('fails fast on an unreachable server and never leaks the password', async () => {
    const secret = 'S3cr3tPassw0rd'
    const uri = `mongodb://dropuser:${secret}@127.0.0.1:1/dropdrop?serverSelectionTimeoutMS=500`
    await assert.rejects(connectDatabase(uri, { serverSelectionTimeoutMS: 500 }), (e) => {
      assert.ok(e instanceof DatabaseConfigError)
      assert.ok(!e.message.includes(secret), 'password leaked in error message')
      assert.ok(!e.message.includes(uri), 'connection string leaked in error message')
      return true
    })
  })

  it('redact() strips passwords and URIs from arbitrary messages', () => {
    const uri = 'mongodb+srv://u:p%40ss@host.example/dropdrop'
    const out = redact(`bad auth for ${uri} (pw p@ss / p%40ss)`, uri)
    assert.ok(!/p@ss|p%40ss|mongodb\+srv:\/\//.test(out), out)
  })
})
