import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { errorHandler } from '../src/middleware/errorHandler.js'
import { sanitizeForLog } from '../src/utils/redact.js'

// Deliberately fake credentials (never real ones).
const PASSWORD = 'Fake-Pa55w0rd!xyz'
const URI = `mongodb+srv://fakeuser:${encodeURIComponent(PASSWORD)}@cluster0.example.mongodb.net/dropdrop?appName=Cluster0`
const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz12'

describe('sanitizeForLog', () => {
  it('removes connection strings, passwords and tokens', () => {
    const raw = `connect failed for ${URI}; password=${PASSWORD}; Authorization: Bearer abcdef1234567890; token ${TOKEN}`
    const out = sanitizeForLog(raw, {})
    for (const secret of [PASSWORD, encodeURIComponent(PASSWORD), 'fakeuser', 'abcdef1234567890', TOKEN, 'cluster0.example']) {
      assert.ok(!out.includes(secret), `leaked: ${secret}`)
    }
    assert.match(out, /redacted/)
    assert.match(out, /connect failed for/)
  })

  it('removes the exact secret values configured in the environment, even without a recognisable pattern', () => {
    const env = { MONGODB_URI: URI, SOME_API_KEY: 'k3y-value-123456', PORT: '5000', NODE_ENV: 'production' }
    const out = sanitizeForLog(`odd failure near ${PASSWORD} and k3y-value-123456 on port 5000 in production`, env)
    assert.ok(!out.includes(PASSWORD) && !out.includes('k3y-value-123456'))
    assert.match(out, /port 5000 in production/, 'non-secret config values are not mangled')
  })

  it('redacts user:pass@ credentials in any URL scheme', () => {
    const out = sanitizeForLog('upstream https://admin:hunter2hunter2@db.internal/x failed', {})
    assert.ok(!out.includes('hunter2hunter2') && !out.includes('admin:'))
  })

  it('truncates very long messages and tolerates non-strings', () => {
    assert.ok(sanitizeForLog('x'.repeat(5000), {}).length < 600)
    assert.equal(sanitizeForLog(undefined, {}), '')
    assert.equal(typeof sanitizeForLog({ a: 1 }, {}), 'string')
  })

  it('leaves ordinary messages readable', () => {
    assert.equal(sanitizeForLog('Cannot read properties of undefined (reading "clock")', {}), 'Cannot read properties of undefined (reading "clock")')
  })
})

describe('unhandled-error logging (real errorHandler)', () => {
  let logged
  let originalError
  let savedUri
  beforeEach(() => {
    logged = []
    originalError = console.error
    console.error = (...args) => logged.push(args.join(' '))
    savedUri = process.env.MONGODB_URI
    process.env.MONGODB_URI = URI
  })
  afterEach(() => {
    console.error = originalError
    if (savedUri === undefined) delete process.env.MONGODB_URI
    else process.env.MONGODB_URI = savedUri
  })

  const appThatThrows = (err) => {
    const app = express()
    app.get('/boom', () => {
      throw err
    })
    app.use(errorHandler)
    return app
  }

  it('logs the error class and a sanitised message, never secrets, and returns a generic 500', async () => {
    const err = new Error(`failed to reach ${URI} with password=${PASSWORD} (Bearer abcdef1234567890)`)
    err.name = 'MongoServerSelectionError'
    err.code = 'ECONNREFUSED'
    const res = await request(appThatThrows(err)).get('/boom')
    assert.equal(res.status, 500)
    assert.equal(res.body.error.code, 'INTERNAL_ERROR')
    assert.ok(!JSON.stringify(res.body).includes('mongodb'), 'response leaks nothing')
    const line = logged.join('\n')
    assert.match(line, /MongoServerSelectionError/)
    assert.match(line, /ECONNREFUSED/)
    for (const secret of [PASSWORD, encodeURIComponent(PASSWORD), 'fakeuser', 'abcdef1234567890', 'cluster0.example']) {
      assert.ok(!line.includes(secret), `log leaked: ${secret}`)
    }
  })

  it('does not print stack traces', async () => {
    await request(appThatThrows(new Error('plain failure'))).get('/boom')
    assert.ok(!logged.join('\n').includes(' at '), 'no stack frames in the log')
  })
})
