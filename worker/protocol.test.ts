import { describe, expect, it } from 'vitest'
import { MAX_SEALED_LENGTH, parseClientMessage } from './protocol'

describe('worker protocol', () => {
  it('accepts hello and sealed clipboard messages', () => {
    expect(parseClientMessage({ type: 'hello', version: 1, device: 'phone' })).not.toBeNull()
    expect(parseClientMessage({ type: 'clipboard-item', id: '1', sealed: 'abc.def', createdAt: 1 })).not.toBeNull()
  })

  it('rejects unsealed clipboard messages', () => {
    expect(parseClientMessage({ type: 'clipboard-item', id: '1', text: 'plaintext', createdAt: 1 })).toBeNull()
  })

  it('accepts key-exchange messages with an optional confirmation', () => {
    expect(parseClientMessage({ type: 'key-exchange', id: 'k1', publicKey: 'abc', createdAt: 1 })).not.toBeNull()
    expect(parseClientMessage({ type: 'key-exchange', id: 'k1', publicKey: 'abc', confirm: 'def', createdAt: 1 })).not.toBeNull()
  })

  it('rejects malformed key-exchange messages', () => {
    expect(parseClientMessage({ type: 'key-exchange', id: 'k1', createdAt: 1 })).toBeNull()
    expect(parseClientMessage({ type: 'key-exchange', id: 'k1', publicKey: '', createdAt: 1 })).toBeNull()
    expect(parseClientMessage({ type: 'key-exchange', id: 'k1', publicKey: 'x'.repeat(257), createdAt: 1 })).toBeNull()
    expect(parseClientMessage({ type: 'key-exchange', id: 'k1', publicKey: 'abc', confirm: 'x'.repeat(129), createdAt: 1 })).toBeNull()
  })

  it('accepts clear-history and ack messages', () => {
    expect(parseClientMessage({ type: 'clear-history' })).not.toBeNull()
    expect(parseClientMessage({ type: 'ack', id: 'item-1' })).not.toBeNull()
    expect(parseClientMessage({ type: 'ack', id: '' })).not.toBeNull()
    expect(parseClientMessage({ type: 'ack', id: 'x'.repeat(81) })).toBeNull()
  })

  it('rejects unknown and oversized messages', () => {
    expect(parseClientMessage({ type: 'nope' })).toBeNull()
    expect(parseClientMessage({ type: 'clipboard-item', id: '1', sealed: 'x'.repeat(MAX_SEALED_LENGTH + 1), createdAt: 1 })).toBeNull()
  })
})
