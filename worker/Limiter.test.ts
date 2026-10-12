import { describe, expect, it } from 'vitest'
import { Limiter, MAX_PER_IP_PER_HOUR, WINDOW_MS } from './Limiter'

function fakeLimiterState() {
  const store = new Map<string, unknown>()
  const deleted: string[] = []
  return {
    store,
    deleted,
    state: {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, value)
        },
        delete: async (key: string) => {
          deleted.push(key)
          store.delete(key)
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

describe('Limiter /consume', () => {
  it('allows attempts up to the cap, then rejects with Retry-After and no-store', async () => {
    const { state } = fakeLimiterState()
    const limiter = new Limiter(state)
    for (let i = 0; i < MAX_PER_IP_PER_HOUR; i += 1) {
      const response = await limiter.fetch(post('/consume', { ip: '203.0.113.7' }))
      expect(response.status).toBe(200)
    }
    const limited = await limiter.fetch(post('/consume', { ip: '203.0.113.7' }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('3600')
    expect(limited.headers.get('Cache-Control')).toBe('no-store')
  })

  it('counts every attempt atomically, so parallel joins cannot race a stale check', async () => {
    const { state, store } = fakeLimiterState()
    const limiter = new Limiter(state)
    await limiter.fetch(post('/consume', { ip: '203.0.113.7' }))
    await limiter.fetch(post('/consume', { ip: '203.0.113.7' }))
    expect((store.get('ip:203.0.113.7') as { count: number }).count).toBe(2)
  })

  it('starts fresh once the window expires, even from a full bucket', async () => {
    const { state } = fakeLimiterState()
    const limiter = new Limiter(state)
    // Seed a full, expired window directly in storage.
    await state.storage.put('ip:203.0.113.7', {
      count: MAX_PER_IP_PER_HOUR,
      windowStart: Date.now() - WINDOW_MS - 1_000,
    })
    const response = await limiter.fetch(post('/consume', { ip: '203.0.113.7' }))
    expect(response.status).toBe(200)
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

  it('keeps the legacy limit/success paths working', async () => {
    const { state } = fakeLimiterState()
    const limiter = new Limiter(state)
    expect((await limiter.fetch(post('/limit', { ip: '203.0.113.7' }))).status).toBe(200)
    expect((await limiter.fetch(post('/success', { ip: '203.0.113.7' }))).status).toBe(200)
    expect((await limiter.fetch(post('/limit', { ip: '203.0.113.7' }))).status).toBe(200)
  })
})
