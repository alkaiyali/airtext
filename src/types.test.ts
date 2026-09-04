import { describe, expect, it } from 'vitest'
import { createRoomCode, MAX_CONFIRM_LENGTH, MAX_IMAGE_BYTES, MAX_PUBKEY_LENGTH, MAX_SEALED_LENGTH, MAX_TEXT_LENGTH, roomInviteUrl } from './types'

describe('createRoomCode', () => {
  it('generates 8-character codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      expect(createRoomCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/)
    }
  })

  it('spreads every position across the alphabet (no per-position bias)', () => {
    // Regression guard: the old byte.toString(36) generator could only ever
    // produce 0-7 at even positions, cutting keyspace to ~32 bits. Dynamic
    // membership tracking per position is exactly Set territory.
    const draws = Array.from({ length: 4000 }, createRoomCode)
    for (let position = 0; position < 8; position++) {
      const seen = new Set<string>()
      for (const code of draws) seen.add(code[position])
      expect(seen.size).toBeGreaterThanOrEqual(16)
    }
  })
})

describe('client limits shared with the worker protocol', () => {
  it('stay aligned with worker/protocol.ts', () => {
    expect(MAX_TEXT_LENGTH).toBe(100_000)
    expect(MAX_IMAGE_BYTES).toBe(350_000)
    expect(MAX_SEALED_LENGTH).toBe(900_000)
    expect(MAX_PUBKEY_LENGTH).toBe(256)
    expect(MAX_CONFIRM_LENGTH).toBe(128)
  })
})

describe('roomInviteUrl', () => {
  it('carries the code in the query string, which phone scanners preserve', () => {
    // Regression guard: the #join= fragment variant was stripped or mangled
    // by several phone scanner chains and silently broke pairing.
    const stubWindow = { location: { href: 'https://airtext.example/pairing?stale=1#old' } } as unknown as Window & typeof globalThis
    globalThis.window = stubWindow
    expect(roomInviteUrl('AB12CD34')).toBe('https://airtext.example/pairing?join=AB12CD34')
  })
})
