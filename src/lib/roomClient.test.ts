import { afterEach, describe, expect, it, vi } from 'vitest'
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
const stubWebSocket = { OPEN: 1, CONNECTING: 0 } as unknown as typeof WebSocket
globalThis.WebSocket = stubWebSocket

interface SentMessage {
  sealed: string
}

describe('connect timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the timeout and keeps retrying with backoff when the socket never opens', () => {
    vi.useFakeTimers()
    const events: RoomClientEvent[] = []
    const opened: Array<{ closed: boolean }> = []
    const client = new RoomClient('AB12CD34', 'desktop', () => {
      const fake = {
        readyState: 0,
        closed: false,
        send: () => undefined,
        close() { this.closed = true },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }
      opened.push(fake)
      return fake as unknown as WebSocket
    })
    client.subscribe((event) => events.push(event))
    client.connect()
    vi.advanceTimersByTime(10_000)
    const timeout = events.find((event) => event.type === 'status' && event.status === 'error')
    expect(timeout).toMatchObject({ message: 'Could not reach the room. Retrying…' })
    expect(opened[0].closed).toBe(true)
    // A hung upgrade is usually a dead network that comes back: try again.
    vi.advanceTimersByTime(1_000)
    expect(opened).toHaveLength(2)
    client.close()
  })
})

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
      if (!['key-exchange', 'clipboard-item', 'ack', 'clear-history'].includes(message.type)) return
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
      a, b, eventsA, eventsB, sockets,
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

  it('clears the peer history only via a sealed, non-replayable control', async () => {
    const pair = linkedPair('AB12CD34')
    const relayedClears: unknown[] = []
    pair.a.connect()
    pair.b.connect()
    pair.open()
    await waitFor(() => fingerprint(pair.eventsA) !== '' && fingerprint(pair.eventsB) !== '', 'secure channel')
    const sendA = pair.sockets.a!.send.bind(pair.sockets.a!)
    pair.sockets.a!.send = (data: string) => {
      if (JSON.parse(data).type === 'clear-history') relayedClears.push(JSON.parse(data))
      sendA(data)
    }
    expect(await pair.a.sendClearHistory()).toBe(true)
    await waitFor(() => pair.eventsB.some((event) => event.type === 'cleared'), 'cleared')

    // A forged control (relay or stranger without the key) and a replay are ignored.
    pair.sockets.b!.deliver({ type: 'clear-history', sealed: 'AAAAAAAAAAAAAAAA.AAAA' })
    pair.sockets.b!.deliver({ ...(relayedClears[0] as object), source: 'desktop' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pair.eventsB.filter((event) => event.type === 'cleared')).toHaveLength(1)
    pair.close()
  })

  it('emits a replayed clipboard item once while still acking it', async () => {
    const pair = linkedPair('AB12CD34')
    pair.a.connect()
    pair.b.connect()
    pair.open()
    await waitFor(() => fingerprint(pair.eventsA) !== '' && fingerprint(pair.eventsB) !== '', 'secure channel')
    const sentA: string[] = []
    const sendA = pair.sockets.a!.send.bind(pair.sockets.a!)
    pair.sockets.a!.send = (data: string) => {
      sentA.push(data)
      sendA(data)
    }
    await pair.a.sendClipboardItem('replay-1', 7, { text: 'say once', kind: 'text' })
    await waitFor(() => pair.eventsB.some((event) => event.type === 'decrypted'), 'delivery')

    // A malicious relay replaying the same sealed bytes is acked (to quench
    // sender resends) but never emitted twice.
    const relayed = JSON.parse(sentA.find((data) => JSON.parse(data).type === 'clipboard-item')!) as object
    pair.sockets.b!.deliver({ ...relayed, source: 'desktop' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pair.eventsB.filter((event) => event.type === 'decrypted')).toHaveLength(1)
    pair.close()
  })

  it('identifies with its resume token in hello', async () => {
    const sent: string[] = []
    const holder: { socket: RelaySocket | null } = { socket: null }
    const client = new RoomClient('AB12CD34', 'phone', () => {
      holder.socket = new RelaySocket((data) => { sent.push(data) })
      return holder.socket as unknown as WebSocket
    }, 'tab-token')
    client.connect()
    holder.socket?.open()
    await waitFor(() => sent.some((data) => JSON.parse(data).type === 'hello'), 'hello')
    expect(JSON.parse(sent.find((data) => JSON.parse(data).type === 'hello')!)).toMatchObject({ resume: 'tab-token' })
    client.close()
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
    return { client, sent, session, holder, peerPub }
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

  it('resends unacknowledged items after the channel re-secures', async () => {
    const { client, sent, session, holder, peerPub } = await securedClient()
    await client.sendClipboardItem('lost', 1, { text: 'dropped in flight', kind: 'text' })
    await client.sendClipboardItem('acked', 2, { text: 'made it', kind: 'text' })
    holder.socket?.deliver({ type: 'ack', id: 'acked' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The link drops and comes back; the peer re-confirms the same session.
    client.retry()
    holder.socket?.open()
    holder.socket?.deliver({ type: 'key-exchange', id: 'peer-2', publicKey: peerPub, confirm: await makeConfirm(session.confirmKey, peerPub), createdAt: 2, source: 'phone' })
    const before = sent.length
    await waitFor(() => sent.slice(before).some((data) => JSON.parse(data).type === 'clipboard-item'), 'resend')
    const resent = sent.slice(before).map((data) => JSON.parse(data) as { type: string; id?: string }).filter((m) => m.type === 'clipboard-item')
    expect(resent.map((m) => m.id)).toEqual(['lost'])
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

describe('relay errors', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function scriptedClient() {
    const listeners = new Map<string, Array<(event: unknown) => void>>()
    const sockets: number[] = []
    const fake = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
      removeEventListener: () => undefined,
    }
    const client = new RoomClient('AB12CD34', 'desktop', () => { sockets.push(1); return fake as unknown as WebSocket })
    const events: RoomClientEvent[] = []
    client.subscribe((event) => events.push(event))
    client.connect()
    const fire = (type: string, event: unknown = {}) => listeners.get(type)?.forEach((fn) => fn(event))
    return { client, events, sockets, fire }
  }

  it('reports a throttled item as a notice, not a connection issue', async () => {
    const { client, events, fire } = scriptedClient()
    fire('message', { data: JSON.stringify({ type: 'error', code: 'rate_limited', message: 'Too many messages. Slow down and try again.' }) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events.some((event) => event.type === 'status' && event.status === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'notice')).toMatchObject({ message: expect.stringContaining('resend') })
    client.close()
  })

  it('stops reconnecting when the network has hit the room-creation limit', async () => {
    vi.useFakeTimers()
    const { client, events, sockets, fire } = scriptedClient()
    fire('message', { data: JSON.stringify({ type: 'error', code: 'room_limit', message: 'Too many new rooms from this network right now. Try again in about 2 minutes.' }) })
    await vi.advanceTimersByTimeAsync(0)
    fire('close')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(1)
    expect(events.find((event) => event.type === 'status' && event.status === 'error')).toMatchObject({ message: expect.stringContaining('2 minutes') })
    client.close()
  })
})
