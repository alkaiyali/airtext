import { describe, expect, it, vi } from 'vitest'
import { Limiter, ROOM_BURST, ROOM_REFILL_MS, refillTokens } from './Limiter'

function fakeLimiterState() {
  const store = new Map<string, unknown>()
  const alarms: number[] = []
  return {
    store,
    alarms,
    state: {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, value)
        },
        setAlarm: async (at: number) => {
          alarms.push(at)
        },
        deleteAll: async () => {
          store.clear()
        },
      },
    } as unknown as DurableObjectState,
  }
}

function post(path: string, body: unknown): Request {
  return new Request(`https://limiter${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const consume = (limiter: Limiter) => limiter.fetch(post('/consume', { ip: '203.0.113.7' }))

describe('Limiter /consume', () => {
  it('allows a full burst, then rejects with a short Retry-After and no-store', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const limiter = new Limiter(fakeLimiterState().state)
    for (let i = 0; i < ROOM_BURST; i += 1) {
      expect((await consume(limiter)).status).toBe(200)
    }
    const limited = await consume(limiter)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe(String(ROOM_REFILL_MS / 1000))
    expect(limited.headers.get('Cache-Control')).toBe('no-store')
    vi.useRealTimers()
  })

  it('recovers gradually instead of locking the network out for an hour', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const limiter = new Limiter(fakeLimiterState().state)
    for (let i = 0; i < ROOM_BURST; i += 1) await consume(limiter)
    expect((await consume(limiter)).status).toBe(429)
    vi.advanceTimersByTime(ROOM_REFILL_MS)
    expect((await consume(limiter)).status).toBe(200)
    expect((await consume(limiter)).status).toBe(429)
    vi.useRealTimers()
  })

  it('schedules deletion of the address for when the bucket is full again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { state, store, alarms } = fakeLimiterState()
    const limiter = new Limiter(state)
    await consume(limiter)
    expect(alarms.at(-1)).toBe(1_000_000 + ROOM_REFILL_MS)
    await limiter.alarm()
    expect(store.size).toBe(0)
    vi.useRealTimers()
  })

  it('treats records from the old fixed-window format as a full bucket', () => {
    expect(refillTokens({ count: 60, windowStart: 0 } as never, Date.now())).toBe(ROOM_BURST)
    expect(refillTokens(undefined, Date.now())).toBe(ROOM_BURST)
    expect(refillTokens({ tokens: 0, updatedAt: 0 }, ROOM_REFILL_MS / 2)).toBe(0.5)
  })

  it('rejects malformed ips instead of storing them', async () => {
    const { state, store } = fakeLimiterState()
    const limiter = new Limiter(state)
    for (const body of [{}, { ip: '' }, { ip: 'x'.repeat(65) }, { ip: 'bad ip!!' }]) {
      const response = await limiter.fetch(post('/consume', body))
      expect(response.status).toBe(400)
    }
    expect(store.size).toBe(0)
  })

  it('rejects unknown paths', async () => {
    const limiter = new Limiter(fakeLimiterState().state)
    expect((await limiter.fetch(post('/limit', { ip: '203.0.113.7' }))).status).toBe(404)
  })
})
