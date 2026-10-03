import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, requireEndpoints, resolveEndpoints, roomShareUrl } from '../../utils/urls'

const dev = { apiUrl: 'http://localhost:5000', websocketUrl: 'ws://localhost:5000', publicAppUrl: 'http://localhost:5173' }

describe('production URL configuration (14)', () => {
  it('development defaults resolve with no errors', () => {
    const r = resolveEndpoints(dev)
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.warnings, [])
    assert.deepEqual(r.endpoints, { apiUrl: 'http://localhost:5000', wsUrl: 'ws://localhost:5000/ws', publicAppUrl: 'http://localhost:5173' })
  })

  it('accepts a production setup: https API, wss WebSocket, Vercel website', () => {
    const r = resolveEndpoints({ apiUrl: 'https://api.dropdrop.example.com/', websocketUrl: 'wss://api.dropdrop.example.com', publicAppUrl: 'https://my-dropdrop.vercel.app/' })
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.warnings, [])
    assert.deepEqual(r.endpoints, {
      apiUrl: 'https://api.dropdrop.example.com',
      wsUrl: 'wss://api.dropdrop.example.com/ws',
      publicAppUrl: 'https://my-dropdrop.vercel.app',
    })
  })

  it('never assumes localhost: values are used exactly as configured', () => {
    const r = resolveEndpoints({ apiUrl: 'https://a.io', websocketUrl: 'wss://b.io', publicAppUrl: 'https://c.io' })
    assert.ok(!JSON.stringify(r.endpoints).includes('localhost'))
  })

  it('does not double-append /ws and supports a path prefix', () => {
    assert.equal(resolveEndpoints({ ...dev, websocketUrl: 'wss://a.io/ws' }).endpoints!.wsUrl, 'wss://a.io/ws')
    assert.equal(resolveEndpoints({ ...dev, websocketUrl: 'wss://a.io/dropdrop/' }).endpoints!.wsUrl, 'wss://a.io/dropdrop/ws')
  })

  it('derives wss:// from an https API when the WebSocket URL is empty', () => {
    assert.equal(resolveEndpoints({ ...dev, apiUrl: 'https://api.io', websocketUrl: '' }).endpoints!.wsUrl, 'wss://api.io/ws')
    assert.equal(resolveEndpoints({ ...dev, apiUrl: 'http://localhost:5000', websocketUrl: '  ' }).endpoints!.wsUrl, 'ws://localhost:5000/ws')
  })

  it('rejects wrong schemes with helpful messages', () => {
    assert.match(resolveEndpoints({ ...dev, apiUrl: 'ws://x.io' }).errors.join(), /dropdrop\.apiUrl must start with http:\/\/ or https:\/\//)
    assert.match(resolveEndpoints({ ...dev, websocketUrl: 'https://x.io' }).errors.join(), /dropdrop\.websocketUrl must start with ws:\/\/ or wss:\/\//)
    assert.match(resolveEndpoints({ ...dev, publicAppUrl: 'ftp://x.io' }).errors.join(), /dropdrop\.publicAppUrl/)
  })

  it('rejects malformed URLs and embedded credentials', () => {
    assert.match(resolveEndpoints({ ...dev, apiUrl: 'not a url' }).errors.join(), /not a valid URL/)
    assert.match(resolveEndpoints({ ...dev, apiUrl: '' }).errors.join(), /not a valid URL/)
    assert.match(resolveEndpoints({ ...dev, apiUrl: 'https://user:pw@x.io' }).errors.join(), /username or password/)
  })

  it('flags insecure combinations for non-local servers', () => {
    assert.match(resolveEndpoints({ ...dev, apiUrl: 'https://x.io', websocketUrl: 'ws://x.io' }).errors.join(), /wss:\/\//)
    const w = resolveEndpoints({ apiUrl: 'http://x.io', websocketUrl: 'ws://x.io', publicAppUrl: 'https://y.io' })
    assert.deepEqual(w.errors, [])
    assert.equal(w.warnings.length, 2)
  })

  it('requireEndpoints throws a ConfigError listing every problem', () => {
    try {
      requireEndpoints({ apiUrl: 'nope', websocketUrl: 'nope', publicAppUrl: 'nope' })
      assert.fail('should throw')
    } catch (e) {
      assert.ok(e instanceof ConfigError)
      assert.equal((e as ConfigError).problems.length, 3)
    }
  })

  it('builds the production share link, encoded, and none when the website URL is unset (7. Copy link)', () => {
    const ep = requireEndpoints({ apiUrl: 'https://api.io', websocketUrl: '', publicAppUrl: 'https://my-dropdrop.vercel.app' })
    assert.equal(roomShareUrl(ep, 'demo-room'), 'https://my-dropdrop.vercel.app/demo-room')
    const none = resolveEndpoints({ apiUrl: 'https://api.io', websocketUrl: '', publicAppUrl: '' })
    assert.equal(none.warnings.length, 1)
    assert.equal(roomShareUrl(none.endpoints!, 'x'), null)
  })
})
