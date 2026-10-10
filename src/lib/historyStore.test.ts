import { describe, expect, it } from 'vitest'
import { normalizeHistory, visibleEntries } from './historyStore'

describe('clipboard history', () => {
  it('keeps repeated text with distinct ids (each share is its own entry)', () => {
    const result = normalizeHistory([
      { id: 'old', text: 'same', createdAt: 1, source: 'this device' },
      { id: 'new', text: 'same', createdAt: 2, source: 'other device' },
    ])
    expect(result.map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  it('drops exact id duplicates, keeping the newest copy', () => {
    const result = normalizeHistory([
      { id: 'dup', text: 'same', createdAt: 1, source: 'this device' },
      { id: 'dup', text: 'same', createdAt: 2, source: 'other device' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].createdAt).toBe(2)
  })

  it('drops blank items and sorts newest first', () => {
    const result = normalizeHistory([
      { id: 'blank', text: '  ', createdAt: 3, source: 'this device' },
      { id: 'old', text: 'old', createdAt: 1, source: 'this device' },
      { id: 'new', text: 'new', createdAt: 2, source: 'this device' },
    ])
    expect(result.map((entry) => entry.id)).toEqual(['new', 'old'])
  })
})

describe('visibleEntries', () => {
  it('shows only the active room and hides leftovers from older sessions', () => {
    const result = visibleEntries([
      { id: 'stale', text: 'from old room', createdAt: 3, source: 'this device', roomId: 'OLDRM001' },
      { id: 'current', text: 'current room item', createdAt: 2, source: 'other device', roomId: 'NEWRM001' },
      { id: 'legacy', text: 'no room tag', createdAt: 1, source: 'this device' },
    ], 'NEWRM001')
    expect(result.map((entry) => entry.id)).toEqual(['current'])
  })

  it('returns nothing without an active room', () => {
    expect(visibleEntries([{ id: 'a', text: 'x', createdAt: 1, source: 'this device', roomId: 'NEWRM001' }], '')).toEqual([])
  })
})
