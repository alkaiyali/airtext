import { afterEach, describe, expect, it, vi } from 'vitest'
import Room, { isOriginAllowed, shouldAnnounceJoin } from './Room'

interface WireMessage {
  type: string
  code?: string
}

function fakeSocket() {
  const sent: string[] = []
  const socket = {
    sent,
    closedWith: '' as string,
    send: (data: string) => { sent.push(data) },
    close: (_code?: number, reason?: string) => { socket.closedWith = reason ?? 'closed' },
    serializeAttachment: () => undefined,
    deserializeAttachment: () => null,
  }
  return socket
}

function fakeState(alarms: number[] = []): DurableObjectState {
  return {
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
    storage: { setAlarm: async (at: number) => { alarms.push(at) }, deleteAll: async () => undefined },
  } as unknown as DurableObjectState
}

type Fake = ReturnType<typeof fakeSocket>

async function say(room: Room, socket: Fake, message: unknown): Promise<void> {
  await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(message))
}

function wire(socket: ReturnType<typeof fakeSocket>): string[] {
  return socket.sent.map((raw) => (JSON.parse(raw) as WireMessage).type)
}

function errors(socket: ReturnType<typeof fakeSocket>): WireMessage[] {
  return socket.sent.map((raw) => JSON.parse(raw) as WireMessage).filter((message) => message.type === 'error')
}

describe('key-exchange rate limiting', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('forwards the confirmation sent one round-trip after the offer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    const phone = fakeSocket()
    await room.webSocketMessage(desktop as unknown as WebSocket, JSON.stringify({ type: 'hello', version: 1, device: 'desktop' }))
    await room.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ type: 'hello', version: 1, device: 'phone' }))
    await room.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ type: 'key-exchange', id: 'offer', publicKey: 'p'.repeat(88), createdAt: 0 }))
    // Half RTT back, an ECDH derive, half RTT out: well under the old 200ms
    // interval on any low-latency network.
    vi.advanceTimersByTime(40)
    await room.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ type: 'key-exchange', id: 'confirm', publicKey: 'p'.repeat(88), confirm: 'c', createdAt: 40 }))

    const forwarded = wire(desktop).filter((type) => type === 'key-exchange')
    expect(forwarded).toHaveLength(2)
    expect(errors(phone)).toHaveLength(0)
  })

  it('still throttles a sustained key-exchange flood from one socket', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    const phone = fakeSocket()
    await room.webSocketMessage(desktop as unknown as WebSocket, JSON.stringify({ type: 'hello', version: 1, device: 'desktop' }))
    await room.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ type: 'hello', version: 1, device: 'phone' }))
    for (let i = 0; i < 10; i += 1) {
      await room.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ type: 'key-exchange', id: `k${i}`, publicKey: 'p'.repeat(88), createdAt: i }))
    }

    const forwarded = wire(desktop).filter((type) => type === 'key-exchange')
    expect(forwarded.length).toBeLessThan(10)
    expect(errors(phone).some((message) => message.code === 'rate_limited')).toBe(true)
  })
})

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

describe('device replacement', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not let a stranger with the room code kick a live device', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    const phone = fakeSocket()
    const intruder = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop', resume: 'desk' })
    await say(room, phone, { type: 'hello', version: 1, device: 'phone', resume: 'real-phone' })
    await say(room, intruder, { type: 'hello', version: 1, device: 'phone', resume: 'other' })

    expect(phone.closedWith).toBe('')
    expect(intruder.closedWith).toBe('device_in_use')
    await say(room, desktop, { type: 'clipboard-item', id: 'x', sealed: 'a.b', createdAt: 1 })
    expect(wire(phone)).toContain('clipboard-item')
    expect(wire(intruder)).not.toContain('clipboard-item')
  })

  it('lets the same client replace its own live socket on reconnect', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const old = fakeSocket()
    const fresh = fakeSocket()
    await say(room, old, { type: 'hello', version: 1, device: 'phone', resume: 'mine' })
    await say(room, fresh, { type: 'hello', version: 1, device: 'phone', resume: 'mine' })
    expect(old.closedWith).toBe('replaced')
    expect(fresh.closedWith).toBe('')
  })

  it('lets anyone replace a socket that has gone stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const old = fakeSocket()
    const fresh = fakeSocket()
    await say(room, old, { type: 'hello', version: 1, device: 'phone', resume: 'old-tab' })
    vi.advanceTimersByTime(31_000)
    await say(room, fresh, { type: 'hello', version: 1, device: 'phone', resume: 'new-tab' })
    expect(old.closedWith).toBe('replaced')
    expect(fresh.closedWith).toBe('')
  })
})

describe('unidentified sockets', () => {
  it('cannot forge acks or clear the peer history', async () => {
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    const stranger = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    await say(room, stranger, { type: 'ack', id: 'item-1' })
    await say(room, stranger, { type: 'clear-history', sealed: 'a.b' })
    expect(wire(desktop)).not.toContain('ack')
    expect(wire(desktop)).not.toContain('clear-history')
    expect(errors(stranger).every((message) => message.code === 'not_ready')).toBe(true)
  })

  it('relays sealed clear-history between identified peers', async () => {
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    const phone = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    await say(room, phone, { type: 'hello', version: 1, device: 'phone' })
    await say(room, phone, { type: 'clear-history', sealed: 'a.b' })
    const relayed = desktop.sent.map((raw) => JSON.parse(raw) as { type: string; sealed?: string }).find((m) => m.type === 'clear-history')
    expect(relayed?.sealed).toBe('a.b')
  })
})

describe('alarms', () => {
  it('stops waking once every socket is identified, and reaps empty rooms', async () => {
    const alarms: number[] = []
    const room = new Room(fakeState(alarms), {} as never)
    const desktop = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    await room.alarm()
    expect(alarms).toHaveLength(0)

    await room.webSocketClose(desktop as unknown as WebSocket)
    expect(alarms).toHaveLength(1)
    expect(alarms[0] - Date.now()).toBeGreaterThan(29 * 60 * 1000)
  })
})
