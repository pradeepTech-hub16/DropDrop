import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clientIpFromRequest, normalizeIp } from '../src/utils/clientIp.js'

const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } })

describe('client IP behind trusted proxies (X-Forwarded-For is client-controlled)', () => {
  it('with no trusted proxy the header is IGNORED entirely', () => {
    assert.equal(clientIpFromRequest(req('203.0.113.9', '6.6.6.6'), 0), '203.0.113.9')
    assert.equal(clientIpFromRequest(req('203.0.113.9', '6.6.6.6')), '203.0.113.9')
  })
  it('one trusted proxy: uses the address the proxy appended (rightmost)', () => {
    assert.equal(clientIpFromRequest(req('10.0.0.1', '198.51.100.7'), 1), '198.51.100.7')
  })
  it('forged leading entries are ignored (the attack this fix closes)', () => {
    assert.equal(clientIpFromRequest(req('10.0.0.1', '1.2.3.4, 5.6.7.8, 198.51.100.7'), 1), '198.51.100.7')
    // two different forged prefixes, same real client => same identity
    assert.equal(
      clientIpFromRequest(req('10.0.0.1', 'aaa, 198.51.100.7'), 1),
      clientIpFromRequest(req('10.0.0.1', '9.9.9.9, 198.51.100.7'), 1),
    )
  })
  it('two trusted proxies: the second entry from the right', () => {
    assert.equal(clientIpFromRequest(req('10.0.0.1', '1.1.1.1, 198.51.100.7, 172.16.0.5'), 2), '198.51.100.7')
  })
  it('falls back to the direct peer if the header is missing, too short, or not an IP', () => {
    assert.equal(clientIpFromRequest(req('10.0.0.1'), 1), '10.0.0.1')
    assert.equal(clientIpFromRequest(req('10.0.0.1', '198.51.100.7'), 2), '10.0.0.1')
    assert.equal(clientIpFromRequest(req('10.0.0.1', 'not-an-ip'), 1), '10.0.0.1')
    assert.equal(clientIpFromRequest(req('10.0.0.1', '<script>, '), 1), '10.0.0.1')
    assert.equal(clientIpFromRequest(req('10.0.0.1', ''), 1), '10.0.0.1')
  })
  it('handles IPv6, IPv4-mapped IPv6, repeated headers and unknown peers', () => {
    assert.equal(clientIpFromRequest(req('::ffff:10.0.0.1', '2001:db8::1'), 1), '2001:db8::1')
    assert.equal(clientIpFromRequest(req('10.0.0.1', '::ffff:198.51.100.7'), 1), '198.51.100.7')
    assert.equal(clientIpFromRequest({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': ['1.1.1.1', '198.51.100.7'] } }, 1), '198.51.100.7')
    assert.equal(clientIpFromRequest({ socket: {}, headers: {} }, 0), 'unknown')
    assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4')
  })
})
