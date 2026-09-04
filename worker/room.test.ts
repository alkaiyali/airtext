import { describe, expect, it } from 'vitest'
import { isOriginAllowed, shouldAnnounceJoin } from './Room'

describe('isOriginAllowed', () => {
  it('allows missing origin (native clients, camera quick actions)', () => {
    expect(isOriginAllowed(null, 'https://airtext.example/room/AB12CD34')).toBe(true)
  })

  it('allows same-host origins', () => {
    expect(isOriginAllowed('https://airtext.example', 'https://airtext.example/room/AB12CD34')).toBe(true)
  })

  it('rejects cross-origin and malformed origins without throwing', () => {
    expect(isOriginAllowed('https://evil.example', 'https://airtext.example/room/AB12CD34')).toBe(false)
    expect(isOriginAllowed('not a url', 'https://airtext.example/room/AB12CD34')).toBe(false)
  })
})

describe('shouldAnnounceJoin', () => {
  it('announces only genuinely new device registrations', () => {
    expect(shouldAnnounceJoin(null, 'desktop')).toBe(true)
    expect(shouldAnnounceJoin('desktop', 'desktop')).toBe(false)
    expect(shouldAnnounceJoin('phone', 'desktop')).toBe(true)
  })
})
