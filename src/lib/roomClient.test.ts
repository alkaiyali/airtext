import { describe, expect, it } from 'vitest'
import { getRoomIdFromCode, MAX_SEALED_LENGTH, MAX_TEXT_LENGTH } from '../types'
import { deriveSession, exportPublicKey, generateKeyPair, makeConfirm, open } from './crypto'
import { parseInvite, RoomClient, type RoomClientEvent } from './roomClient'

describe('room invites', () => {
  it('accepts a room code with human spacing', () => {
    expect(getRoomIdFromCode('ab12 cd34')).toBe('AB12CD34')
    expect(parseInvite('AB12-CD34')).toBe('AB12CD34')
  })

  it('extracts a room code from an invite URL', () => {
    expect(parseInvite('https://airtext.example/#join=AB12CD34')).toBe('AB12CD34')
    expect(parseInvite('https://airtext.example/?join=AB12CD34')).toBe('AB12CD34')
  })

  it('rejects incomplete codes', () => {
    expect(getRoomIdFromCode('ABC')).toBeNull()
    expect(parseInvite('not a room code')).toBeNull()
    expect(parseInvite('https://airtext.example/#join=SHORT')).toBeNull()
  })
})

// Test-only globals for vitest's node environment: the stubs provide exactly
// the members the client reads (location for the socket URL, OPEN for state
// checks, timers for keepalive/reconnect). Real sockets are never opened —
// the DI factory below injects a fake.
const stubWindow = {
  location: { protocol: 'https:', host: 'airtext.example' },
  setInterval: (fn: (...args: never[]) => void, ms: number) => setInterval(fn, ms),
  clearInterval: (id: unknown) => clearInterval(id as NodeJS.Timeout),
  setTimeout: (fn: (...args: never[]) => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as NodeJS.Timeout),
} as unknown as Window & typeof globalThis
globalThis.window = stubWindow
const stubWebSocket = { OPEN: 1 } as unknown as typeof WebSocket
globalThis.WebSocket = stubWebSocket

interface SentMessage {
  sealed: string
}

describe('reconnect', () => {
  it('retry() opens a fresh socket after a failure', () => {
    let sockets = 0
    const fake = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    // The fake implements every WebSocket member RoomClient touches; the
    // factory parameter is the DI seam that lets tests inject it.
    const client = new RoomClient('AB12CD34', 'desktop', () => { sockets += 1; return fake as unknown as WebSocket })
    client.connect()
    expect(sockets).toBe(1)
    client.retry()
    expect(sockets).toBe(2)
    client.close()
  })
})

/** In-memory socket pair with a mini relay: forwards client messages to the
 * other side shaped as server messages, like the Durable Object does. */
class RelaySocket {
  readyState = 1
  private readonly handlers = new Map<string, Array<(event: { data?: string }) => void>>()

  constructor(private readonly onSend: (data: string) => void) {}

  addEventListener(type: string, fn: (event: { data?: string }) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(fn)
    this.handlers.set(type, list)
  }

  removeEventListener(): void {}

  send(data: string): void {
    this.onSend(data)
  }

  close(): void {
    this.readyState = 3
    this.fire('close', {})
  }

  open(): void {
    this.fire('open', {})
  }

  deliver(message: unknown): void {
    setTimeout(() => this.fire('message', { data: JSON.stringify(message) }), 0)
  }

  private fire(type: string, event: { data?: string }): void {
    for (const fn of this.handlers.get(type) ?? []) fn(event)
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('secure channel', () => {
  function linkedPair(code: string) {
    const eventsA: RoomClientEvent[] = []
    const eventsB: RoomClientEvent[] = []
    // Object properties (unlike captured locals) aren't flow-narrowed, so the
    // sockets stay reachable after the factories run.
    const sockets: { a: RelaySocket | null; b: RelaySocket | null } = { a: null, b: null }
    function route(from: 'a' | 'b', sender: 'desktop' | 'phone', data: string): void {
      const message = JSON.parse(data) as { type: string }
      if (message.type !== 'key-exchange' && message.type !== 'clipboard-item' && message.type !== 'ack') return
      const target = from === 'a' ? sockets.b : sockets.a
      target?.deliver({ ...message, source: sender })
    }
    const a = new RoomClient(code, 'desktop', () => {
      sockets.a = new RelaySocket((data) => route('a', 'desktop', data))
      return sockets.a as unknown as WebSocket
    })
    const b = new RoomClient(code, 'phone', () => {
      sockets.b = new RelaySocket((data) => route('b', 'phone', data))
      return sockets.b as unknown as WebSocket
    })
    a.subscribe((event) => eventsA.push(event))
    b.subscribe((event) => eventsB.push(event))
    return {
      a, b, eventsA, eventsB,
      open() {
        sockets.a?.open()
        sockets.b?.open()
        sockets.a?.deliver({ type: 'hello', version: 1, peers: 2 })
        sockets.b?.deliver({ type: 'hello', version: 1, peers: 2 })
      },
      close() {
        a.close()
        b.close()
      },
    }
  }

  function fingerprint(events: RoomClientEvent[]): string {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'secure') return event.fingerprint
    }
    return ''
  }

  it('establishes matching fingerprints on both sides and relays text', async () => {
    const pair = linkedPair('AB12CD34')
    pair.a.connect()
    pair.b.connect()
    pair.open()
    await waitFor(() => fingerprint(pair.eventsA) !== '' && fingerprint(pair.eventsB) !== '', 'secure channel')
    expect(fingerprint(pair.eventsA)).toBe(fingerprint(pair.eventsB))

    await pair.a.sendClipboardItem('id-9', 123, { text: 'hello phone', kind: 'text' })
    await waitFor(() => pair.eventsB.some((event) => event.type === 'decrypted'), 'delivery')
    const decrypted = pair.eventsB.find((event) => event.type === 'decrypted')
    expect(decrypted?.payload.text).toBe('hello phone')
    expect(decrypted?.payload.id).toBe('id-9')
    pair.close()
  })

  it('refuses to share before the channel is secure', async () => {
    const pair = linkedPair('AB12CD34')
    pair.a.connect()
    pair.b.connect()
    pair.open()
    // Immediately: sockets open but the ECDH round trip hasn't completed.
    await expect(pair.a.sendClipboardItem('id-x', 1, { text: 'too soon', kind: 'text' })).rejects.toThrow()
    pair.close()
  })
})

describe('sendClipboardItem size guard', () => {
  /** A client paired against a real (test-side) peer key, driven to secure. */
  async function securedClient() {
    const sent: string[] = []
    const events: RoomClientEvent[] = []
    const holder: { socket: RelaySocket | null } = { socket: null }
    const client = new RoomClient('AB12CD34', 'desktop', () => {
      holder.socket = new RelaySocket((data) => { sent.push(data) })
      return holder.socket as unknown as WebSocket
    })
    client.subscribe((event) => events.push(event))
    client.connect()
    holder.socket?.open()
    // Wait for our introduction, then answer as the peer with real crypto.
    await waitFor(() => sent.some((data) => JSON.parse(data).type === 'key-exchange'), 'introduction')
    const intro = JSON.parse(sent.find((data) => JSON.parse(data).type === 'key-exchange')!) as { publicKey: string }
    const peer = await generateKeyPair()
    const peerPub = await exportPublicKey(peer)
    const session = await deriveSession(peer, intro.publicKey, 'AB12CD34')
    holder.socket?.deliver({
      type: 'key-exchange',
      id: 'peer-1',
      publicKey: peerPub,
      confirm: await makeConfirm(session.confirmKey, peerPub),
      createdAt: 1,
      source: 'phone',
    })
    await waitFor(() => events.some((event) => event.type === 'secure'), 'secure')
    return { client, sent, session }
  }

  it('sends an item at the documented text limit', async () => {
    const { client, sent } = await securedClient()
    await client.sendClipboardItem('id-1', 1, { text: 'a'.repeat(MAX_TEXT_LENGTH), kind: 'text' })
    const sealed = (JSON.parse(sent[sent.length - 1]) as SentMessage).sealed
    expect(sealed.length).toBeLessThanOrEqual(MAX_SEALED_LENGTH)
    client.close()
  })

  it('seals so the paired peer key opens it', async () => {
    const { client, sent, session } = await securedClient()
    await client.sendClipboardItem('id-3', 3, { text: 'peer readable', kind: 'text' })
    const sealed = (JSON.parse(sent[sent.length - 1]) as SentMessage).sealed
    expect(await open(session.messageKey, sealed)).toContain('peer readable')
    client.close()
  })

  it('rejects an item whose sealed form exceeds the transfer budget', async () => {
    const { client, sent } = await securedClient()
    const before = sent.length
    const oversized = 'a'.repeat(MAX_TEXT_LENGTH) + 'A'.repeat(600_000)
    await expect(client.sendClipboardItem('id-2', 2, { text: oversized, kind: 'text' })).rejects.toThrow(/too large/)
    expect(sent).toHaveLength(before)
    client.close()
  })
})
