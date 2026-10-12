import { afterEach, describe, expect, it, vi } from 'vitest'
import Room, { isOriginAllowed, roomLimitMessage, shouldAnnounceJoin } from './Room'

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
    await room.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ type: 'key-exchange', id: 'offer', publicKey: 'p'.repeat(88), createdAt: 1000000 }))
    // Half RTT back, an ECDH derive, half RTT out: well under the old 200ms
    // interval on any low-latency network.
    vi.advanceTimersByTime(40)
    await room.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ type: 'key-exchange', id: 'confirm', publicKey: 'p'.repeat(88), confirm: 'c', createdAt: 1000040 }))

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
      await room.webSocketMessage(phone as unknown as WebSocket, JSON.stringify({ type: 'key-exchange', id: `k${i}`, publicKey: 'p'.repeat(88), createdAt: 1000000 + i }))
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

describe('anti-abuse', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops replayed clipboard ids at the relay', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    const phone = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    await say(room, phone, { type: 'hello', version: 1, device: 'phone' })
    await say(room, desktop, { type: 'clipboard-item', id: 'dup', sealed: 'a.b', createdAt: 1000000 })
    vi.advanceTimersByTime(1_100)
    await say(room, desktop, { type: 'clipboard-item', id: 'dup', sealed: 'a.b', createdAt: 1001100 })

    expect(wire(phone).filter((type) => type === 'clipboard-item')).toHaveLength(1)
    expect(errors(desktop).some((message) => message.code === 'duplicate')).toBe(true)
  })

  it('throttles ping floods without breaking the 15s keepalive', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    await say(room, desktop, { type: 'ping', timestamp: 1000000 })
    expect(wire(desktop)).toContain('pong')
    await say(room, desktop, { type: 'ping', timestamp: 1000000 })
    expect(errors(desktop).some((message) => message.code === 'rate_limited')).toBe(true)
    vi.advanceTimersByTime(15_000)
    await say(room, desktop, { type: 'ping', timestamp: 1015000 })
    expect(wire(desktop).filter((type) => type === 'pong')).toHaveLength(2)
  })

  it('throttles hello flaps so status cannot flap', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    expect(errors(desktop).some((message) => message.code === 'rate_limited')).toBe(true)
  })

  it('throttles ack/clear-history spam toward the peer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    const phone = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    await say(room, phone, { type: 'hello', version: 1, device: 'phone' })
    await say(room, phone, { type: 'ack', id: 'a1' })
    await say(room, phone, { type: 'ack', id: 'a2' })
    expect(wire(desktop).filter((type) => type === 'ack')).toHaveLength(1)
    expect(errors(phone).some((message) => message.code === 'rate_limited')).toBe(true)
  })

  it('sheds sockets past the violation cap instead of warning forever', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const phone = fakeSocket()
    for (let i = 0; i < 35; i += 1) {
      await room.webSocketMessage(phone as unknown as WebSocket, '{oops')
    }
    expect(phone.closedWith).toBe('abuse')
  })
})

describe('room creation limit', () => {
  function limiterEnv(responses: number[]) {
    const calls: string[] = []
    const env = {
      LIMITER: {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          fetch: async () => {
            calls.push(id)
            const status = responses.shift() ?? 200
            return new Response(null, { status, headers: status === 429 ? { 'Retry-After': '90' } : {} })
          },
        }),
      },
    }
    return { env: env as never, calls }
  }

  function storageState(store = new Map<string, unknown>()): DurableObjectState {
    return {
      getWebSockets: () => [],
      acceptWebSocket: () => undefined,
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value) },
        setAlarm: async () => undefined,
        deleteAll: async () => { store.clear() },
      },
    } as unknown as DurableObjectState
  }

  it('counts only the upgrade that creates the room; joins and reconnects are free', async () => {
    const { env, calls } = limiterEnv([])
    const room = new Room(storageState(), env)
    expect(await room.admit('203.0.113.7')).toBe(0)
    expect(await room.admit('198.51.100.2')).toBe(0)
    expect(await room.admit('203.0.113.7')).toBe(0)
    expect(calls).toEqual(['203.0.113.7'])
  })

  it('shares one claim between parallel first upgrades', async () => {
    const { env, calls } = limiterEnv([])
    const room = new Room(storageState(), env)
    await Promise.all([room.admit('203.0.113.7'), room.admit('203.0.113.7')])
    expect(calls).toHaveLength(1)
  })

  it('remembers creation across eviction via storage', async () => {
    const store = new Map<string, unknown>([['created', true]])
    const { env, calls } = limiterEnv([])
    expect(await new Room(storageState(store), env).admit('203.0.113.7')).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('refuses creation over the limit and lets a later attempt re-check', async () => {
    const { env, calls } = limiterEnv([429, 200])
    const room = new Room(storageState(), env)
    expect(await room.admit('203.0.113.7')).toBe(90)
    expect(await room.admit('203.0.113.7')).toBe(0)
    expect(calls).toHaveLength(2)
  })

  it('counts again once an idle room has been reaped', async () => {
    const { env, calls } = limiterEnv([])
    const room = new Room(storageState(), env)
    await room.admit('203.0.113.7')
    await room.alarm()
    await room.admit('203.0.113.7')
    expect(calls).toHaveLength(2)
  })

  it('tells people roughly how long to wait', () => {
    expect(roomLimitMessage(30)).toContain('about 1 minute.')
    expect(roomLimitMessage(150)).toContain('about 3 minutes.')
  })
})

describe('clipboard item rate', () => {
  it('allows a short burst, then about one item per second', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const room = new Room(fakeState(), {} as never)
    const desktop = fakeSocket()
    const phone = fakeSocket()
    await say(room, desktop, { type: 'hello', version: 1, device: 'desktop' })
    await say(room, phone, { type: 'hello', version: 1, device: 'phone' })
    for (let i = 0; i < 4; i += 1) {
      await say(room, desktop, { type: 'clipboard-item', id: `c${i}`, sealed: 'a.b', createdAt: 1000000 })
    }
    expect(wire(phone).filter((type) => type === 'clipboard-item')).toHaveLength(3)
    expect(errors(desktop).some((message) => message.code === 'rate_limited')).toBe(true)
    vi.advanceTimersByTime(1_000)
    await say(room, desktop, { type: 'clipboard-item', id: 'c9', sealed: 'a.b', createdAt: 1001000 })
    expect(wire(phone).filter((type) => type === 'clipboard-item')).toHaveLength(4)
    vi.useRealTimers()
  })
})
