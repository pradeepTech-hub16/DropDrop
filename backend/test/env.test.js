import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_FLUSH_INTERVAL_MS, originsFromEnv, parseFlushInterval, parseOrigins, parseStorageConfig, parseTrustProxy, validateProductionConfig } from '../src/config/env.js'

const prod = (over) => ({ NODE_ENV: 'production', MONGODB_URI: 'x', TRUST_PROXY: 'true', ...over })

describe('production configuration guard', () => {
  it('parses and normalises origin lists', () => {
    assert.deepEqual(parseOrigins(' https://a.app/ , https://b.app,, '), ['https://a.app', 'https://b.app'])
  })
  it('accepts explicit https origins', () => {
    const r = validateProductionConfig(prod({ ALLOWED_ORIGINS: 'https://dropdrop.vercel.app,https://dropdrop.example.com' }))
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.warnings, [])
    assert.deepEqual(r.origins, ['https://dropdrop.vercel.app', 'https://dropdrop.example.com'])
  })
  it('requires origins in production and names both variables', () => {
    const msg = validateProductionConfig(prod({})).errors.join()
    assert.match(msg, /ALLOWED_ORIGINS/)
    assert.match(msg, /CLIENT_URL/)
  })
  it('rejects wildcards, http origins and paths', () => {
    assert.match(validateProductionConfig(prod({ ALLOWED_ORIGINS: '*' })).errors.join(), /wildcard/)
    assert.match(validateProductionConfig(prod({ ALLOWED_ORIGINS: 'http://dropdrop.example.com' })).errors.join(), /https/)
    assert.match(validateProductionConfig(prod({ ALLOWED_ORIGINS: 'https://x.app/some/path' })).errors.join(), /not a valid origin/)
  })
  it('warns (does not fail) about localhost origins and a missing TRUST_PROXY', () => {
    const r = validateProductionConfig(prod({ ALLOWED_ORIGINS: 'https://x.app,http://localhost:5173', TRUST_PROXY: undefined }))
    assert.deepEqual(r.errors, [])
    assert.equal(r.warnings.length, 2)
  })
  it('development: local http origin is fine, falls back to the Vite dev origin, wildcards still rejected', () => {
    assert.deepEqual(validateProductionConfig({ NODE_ENV: 'development', ALLOWED_ORIGINS: 'http://localhost:5173' }).errors, [])
    assert.deepEqual(validateProductionConfig({ NODE_ENV: 'development' }).origins, ['http://localhost:5173'])
    assert.ok(validateProductionConfig({ NODE_ENV: 'development', ALLOWED_ORIGINS: '*' }).errors.length)
  })
})

describe('ALLOWED_ORIGINS is a backward-compatible alias for CLIENT_URL', () => {
  it('the legacy CLIENT_URL alone still works, in development and production', () => {
    assert.deepEqual(originsFromEnv({ CLIENT_URL: 'https://old.app' }), { name: 'CLIENT_URL', raw: 'https://old.app', origins: ['https://old.app'], notes: [] })
    const r = validateProductionConfig(prod({ CLIENT_URL: 'https://old.app' }))
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.origins, ['https://old.app'])
  })
  it('ALLOWED_ORIGINS alone works', () => {
    assert.deepEqual(originsFromEnv({ ALLOWED_ORIGINS: 'https://new.app' }).origins, ['https://new.app'])
  })
  it('both set and equal: no warning', () => {
    const r = validateProductionConfig(prod({ ALLOWED_ORIGINS: 'https://a.app', CLIENT_URL: 'https://a.app/' }))
    assert.deepEqual(r.warnings, [])
  })
  it('both set but different: ALLOWED_ORIGINS wins and a warning explains it (never a union that widens access)', () => {
    const r = validateProductionConfig(prod({ ALLOWED_ORIGINS: 'https://new.app', CLIENT_URL: 'https://old.app' }))
    assert.deepEqual(r.origins, ['https://new.app'])
    assert.match(r.warnings.join(), /ignoring CLIENT_URL/)
  })
  it('an empty ALLOWED_ORIGINS falls back to CLIENT_URL', () => {
    assert.deepEqual(originsFromEnv({ ALLOWED_ORIGINS: '  ', CLIENT_URL: 'https://old.app' }).origins, ['https://old.app'])
  })
  it('validation errors name the variable that was actually used', () => {
    assert.match(validateProductionConfig(prod({ CLIENT_URL: 'http://old.app' })).errors.join(), /CLIENT_URL entry/)
    assert.match(validateProductionConfig(prod({ ALLOWED_ORIGINS: 'http://new.app' })).errors.join(), /ALLOWED_ORIGINS entry/)
  })
})

describe('TRUST_PROXY (number of trusted reverse proxies)', () => {
  it('parses the accepted forms', () => {
    assert.equal(parseTrustProxy(undefined), 0)
    assert.equal(parseTrustProxy(''), 0)
    assert.equal(parseTrustProxy('false'), 0)
    assert.equal(parseTrustProxy('0'), 0)
    assert.equal(parseTrustProxy('true'), 1)
    assert.equal(parseTrustProxy('TRUE'), 1)
    assert.equal(parseTrustProxy('1'), 1)
    assert.equal(parseTrustProxy('2'), 2)
  })
  it('rejects ambiguous or unsafe values', () => {
    for (const v of ['yes', '-1', '11', '1.5', 'loopback', '10.0.0.0/8', '*']) assert.equal(parseTrustProxy(v), null, v)
    assert.match(validateProductionConfig(prod({ ALLOWED_ORIGINS: 'https://a.app', TRUST_PROXY: 'loopback' })).errors.join(), /TRUST_PROXY/)
  })
  it('is exposed to the server as a hop count', () => {
    assert.equal(validateProductionConfig(prod({ ALLOWED_ORIGINS: 'https://a.app', TRUST_PROXY: '2' })).trustedProxyHops, 2)
    assert.equal(validateProductionConfig({ NODE_ENV: 'development' }).trustedProxyHops, 0)
  })
})

describe('COLLAB_FLUSH_INTERVAL_MS (persistence interval, F2)', () => {
  it('defaults to 1000 ms, the long-standing production value', () => {
    assert.equal(validateProductionConfig({ NODE_ENV: 'production', MONGODB_URI: 'x', TRUST_PROXY: '1', ALLOWED_ORIGINS: 'https://a.app' }).flushIntervalMs, 1000)
    assert.equal(validateProductionConfig({ NODE_ENV: 'development' }).flushIntervalMs, 1000)
    assert.equal(DEFAULT_FLUSH_INTERVAL_MS, 1000)
  })
  it('accepts 2-3 second values for free-tier tuning', () => {
    for (const v of ['2000', '2500', '3000']) assert.deepEqual(parseFlushInterval(v), { value: Number(v), error: null })
  })
  it('rejects values that are too small (hammer the database), too large (long loss window) or not whole numbers', () => {
    for (const v of ['0', '100', '249', '10001', '60000', '1.5', '-1', 'abc', '1s', '2e3']) {
      assert.ok(parseFlushInterval(v).error, v)
      assert.equal(parseFlushInterval(v).value, 1000, 'invalid input falls back to the safe default')
    }
    assert.match(validateProductionConfig({ NODE_ENV: 'development', COLLAB_FLUSH_INTERVAL_MS: '50' }).errors.join(), /COLLAB_FLUSH_INTERVAL_MS/)
  })
  it('the collaboration manager itself also defaults to 1000 ms', async () => {
    const { CollabManager } = await import('../src/collab/CollabManager.js')
    assert.equal(new CollabManager().flushIntervalMs, 1000)
  })
})

describe('storage guard settings (F3)', () => {
  it('has conservative defaults: on, 512 MB limit, refuse new rooms at 80%', () => {
    assert.deepEqual(parseStorageConfig({}), { enabled: true, limitMb: 512, thresholdRatio: 0.8, otherDatabasesReserveMb: 0, errors: [] })
  })
  it('accepts overrides and rejects nonsense', () => {
    const ok = parseStorageConfig({ STORAGE_GUARD: 'OFF', STORAGE_LIMIT_MB: '1024', STORAGE_GUARD_THRESHOLD: '0.7', STORAGE_OTHER_DB_RESERVE_MB: '120' })
    assert.deepEqual([ok.enabled, ok.limitMb, ok.thresholdRatio, ok.otherDatabasesReserveMb, ok.errors.length], [false, 1024, 0.7, 120, 0])
    const bad = parseStorageConfig({ STORAGE_LIMIT_MB: 'lots', STORAGE_GUARD_THRESHOLD: '1.5', STORAGE_OTHER_DB_RESERVE_MB: '-5', STORAGE_GUARD: 'maybe' })
    assert.equal(bad.errors.length, 4)
    assert.equal(parseStorageConfig({ STORAGE_GUARD_THRESHOLD: '0.99' }).errors.length, 1, 'a threshold close to 100% would defeat the guard')
  })
})
