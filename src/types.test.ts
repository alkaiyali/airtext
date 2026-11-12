import { describe, expect, it } from 'vitest'
import {
  createRoomCode,
  isSafeImageDataUrl,
  isServerMessage,
  isValidId,
  isValidTimestamp,
  MAX_CONFIRM_LENGTH,
  MAX_ID_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_PUBKEY_LENGTH,
  MAX_RESUME_LENGTH,
  MAX_SEALED_CONTROL_LENGTH,
  MAX_SEALED_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TIMESTAMP,
  roomInviteUrl,
} from './types'

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
    expect(MAX_ID_LENGTH).toBe(80)
    expect(MAX_SEALED_CONTROL_LENGTH).toBe(512)
    expect(MAX_TIMESTAMP).toBe(8_640_000_000_000_000)
    expect(MAX_RESUME_LENGTH).toBe(64)
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

describe('relay message validation', () => {
  const clipboard = { type: 'clipboard-item', id: 'id-1', sealed: 'a.b', createdAt: 1, source: 'desktop' }

  it('accepts valid server messages', () => {
    expect(isServerMessage(clipboard)).toBe(true)
    expect(isServerMessage({ type: 'hello', version: 1, peers: 2 })).toBe(true)
    expect(isServerMessage({ type: 'pong', timestamp: 1 })).toBe(true)
  })

  it('rejects out-of-bounds ids, payloads, and timestamps from the relay', () => {
    expect(isServerMessage({ ...clipboard, id: 'x'.repeat(MAX_ID_LENGTH + 1) })).toBe(false)
    expect(isServerMessage({ ...clipboard, id: '' })).toBe(false)
    expect(isServerMessage({ ...clipboard, sealed: 'x'.repeat(MAX_SEALED_LENGTH + 1) })).toBe(false)
    expect(isServerMessage({ ...clipboard, createdAt: 0 })).toBe(false)
    expect(isServerMessage({ ...clipboard, createdAt: 1.5 })).toBe(false)
    expect(isServerMessage({ ...clipboard, createdAt: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isServerMessage({ ...clipboard, createdAt: MAX_TIMESTAMP + 1 })).toBe(false)
    expect(isServerMessage({ type: 'hello', version: 1, peers: 9 })).toBe(false)
    expect(isServerMessage({ type: 'clear-history', sealed: 'x'.repeat(MAX_SEALED_CONTROL_LENGTH + 1) })).toBe(false)
    expect(isServerMessage({ type: 'error', code: 'x', message: 'x'.repeat(501) })).toBe(false)
  })

  it('bounds key-exchange traffic before it reaches the decoder', () => {
    const exchange = {
      type: 'key-exchange',
      id: 'key-1',
      publicKey: 'A'.repeat(87),
      confirm: 'B'.repeat(43),
      createdAt: 1,
      source: 'phone',
    }
    expect(isServerMessage(exchange)).toBe(true)
    expect(isServerMessage({ ...exchange, publicKey: 'A'.repeat(MAX_PUBKEY_LENGTH + 1) })).toBe(false)
    expect(isServerMessage({ ...exchange, publicKey: 'not base64!' })).toBe(false)
    expect(isServerMessage({ ...exchange, confirm: 'B'.repeat(MAX_CONFIRM_LENGTH + 1) })).toBe(false)
    expect(isServerMessage({ ...exchange, createdAt: Number.NaN })).toBe(false)
  })

  it('validates reusable id and timestamp helpers', () => {
    expect(isValidId('id-1')).toBe(true)
    expect(isValidId('')).toBe(false)
    expect(isValidId('x'.repeat(MAX_ID_LENGTH + 1))).toBe(false)
    expect(isValidTimestamp(1)).toBe(true)
    expect(isValidTimestamp(MAX_TIMESTAMP)).toBe(true)
    expect(isValidTimestamp(0)).toBe(false)
    expect(isValidTimestamp(MAX_TIMESTAMP + 1)).toBe(false)
    expect(isValidTimestamp(1.5)).toBe(false)
    expect(isValidTimestamp(Number.NaN)).toBe(false)
  })
})

describe('isSafeImageDataUrl', () => {
  it('accepts base64 raster data URLs produced by the image pipeline', () => {
    expect(isSafeImageDataUrl('data:image/webp;base64,UklGRg==')).toBe(true)
    expect(isSafeImageDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(true)
  })

  it('rejects remote URLs, SVG, and other schemes from the peer', () => {
    expect(isSafeImageDataUrl('https://tracker.example/pixel.png')).toBe(false)
    expect(isSafeImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isSafeImageDataUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeImageDataUrl('data:image/png;base64,AAAA"onerror="x')).toBe(false)
    expect(isSafeImageDataUrl(42)).toBe(false)
  })
})
