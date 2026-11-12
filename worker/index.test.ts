import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, limiterKey } from './index'

describe('limiterKey', () => {
  it('keeps IPv4 addresses as-is', () => {
    expect(limiterKey('203.0.113.7')).toBe('203.0.113.7')
  })

  it('maps IPv4-mapped IPv6 addresses to the embedded IPv4 bucket', () => {
    expect(limiterKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(limiterKey('::FFFF:198.51.100.2')).toBe('198.51.100.2')
  })

  it('groups IPv6 addresses by /64 so one network cannot rotate past the limit', () => {
    expect(limiterKey('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd:12::/64')
    expect(limiterKey('2001:db8:abcd:12:ffff::9')).toBe('2001:db8:abcd:12::/64')
    expect(limiterKey('2001:0DB8::1')).toBe('2001:db8:0:0::/64')
    expect(limiterKey('::1')).toBe('0:0:0:0::/64')
  })
})

describe('contentSecurityPolicy', () => {
  it('pins sockets to the serving host and forbids inline styles', () => {
    const csp = contentSecurityPolicy('https://airtext.example/room/AB12CD34')
    expect(csp).toContain("connect-src 'self' wss://airtext.example;")
    expect(csp).not.toMatch(/connect-src[^;]* wss: /)
    expect(csp).toContain("style-src 'self';")
    expect(csp).not.toContain("'unsafe-inline'")
  })

  it('uses ws: for plain-HTTP local dev', () => {
    expect(contentSecurityPolicy('http://localhost:8787/')).toContain('ws://localhost:8787')
  })
})
