import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/lib/config.js'

const prodPage = { pageProtocol: 'https:', pageOrigin: 'https://dropdrop.vercel.app' }

describe('frontend deployment config', () => {
  it('development falls back to localhost defaults', () => {
    const c = resolveConfig({ env: {}, dev: true, pageProtocol: 'http:', pageOrigin: 'http://localhost:5173' })
    assert.deepEqual(c.errors, [])
    assert.equal(c.API_URL, 'http://localhost:5000')
    assert.equal(c.WS_URL, 'ws://localhost:5000/ws')
    assert.equal(c.PUBLIC_APP_URL, 'http://localhost:5173')
  })
  it('production NEVER falls back to localhost: missing VITE_API_URL is an error', () => {
    const c = resolveConfig({ env: {}, dev: false, ...prodPage })
    assert.match(c.errors.join(), /VITE_API_URL is not set/)
    assert.equal(c.API_URL, '')
  })
  it('production values: https API, wss WS, public URL', () => {
    const c = resolveConfig({ env: { VITE_API_URL: 'https://api.example.com/', VITE_WS_URL: 'wss://api.example.com', VITE_PUBLIC_APP_URL: 'https://dropdrop.vercel.app/' }, dev: false, ...prodPage })
    assert.deepEqual(c.errors, [])
    assert.equal(c.API_URL, 'https://api.example.com')
    assert.equal(c.WS_URL, 'wss://api.example.com/ws')
    assert.equal(c.PUBLIC_APP_URL, 'https://dropdrop.vercel.app')
  })
  it('accepts a WS URL that already ends in /ws, and derives wss from an https API', () => {
    assert.equal(resolveConfig({ env: { VITE_API_URL: 'https://a.io', VITE_WS_URL: 'wss://a.io/ws' }, dev: false, ...prodPage }).WS_URL, 'wss://a.io/ws')
    assert.equal(resolveConfig({ env: { VITE_API_URL: 'https://a.io' }, dev: false, ...prodPage }).WS_URL, 'wss://a.io/ws')
  })
  it('public URL defaults to the page origin when unset', () => {
    assert.equal(resolveConfig({ env: { VITE_API_URL: 'https://a.io' }, dev: false, ...prodPage }).PUBLIC_APP_URL, 'https://dropdrop.vercel.app')
  })
  it('rejects malformed URLs with helpful messages', () => {
    const c = resolveConfig({ env: { VITE_API_URL: 'api.example.com', VITE_WS_URL: 'https://x.io', VITE_PUBLIC_APP_URL: 'nope' }, dev: false, ...prodPage })
    assert.equal(c.errors.length, 3)
  })
  it('blocks mixed content when the page is HTTPS', () => {
    const c = resolveConfig({ env: { VITE_API_URL: 'http://api.example.com', VITE_WS_URL: 'ws://api.example.com' }, dev: false, ...prodPage })
    assert.match(c.errors.join(), /https/)
    assert.match(c.errors.join(), /wss/)
  })
})
