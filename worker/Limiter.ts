// Room creation is rare (one per pairing): 60 joins/hour/IP is generous for
// normal use while bounding room-spam and code-enumeration from one network.
const MAX_PER_IP_PER_HOUR = 60
const WINDOW_MS = 60 * 60 * 1000
const KEY_PREFIX = 'ip:'

interface RateState {
  count: number
  windowStart: number
}

export class Limiter {
  constructor(private readonly state: DurableObjectState) {}

  private async readOrReset(key: string): Promise<RateState> {
    const now = Date.now()
    const existing = (await this.state.storage.get<RateState>(key)) ?? { count: 0, windowStart: now }
    if (now - existing.windowStart >= WINDOW_MS) {
      existing.count = 0
      existing.windowStart = now
    }
    return existing
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const isSuccess = url.pathname === '/success'
    if (!isSuccess && url.pathname !== '/limit') return new Response('Not found', { status: 404 })
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    let body: { ip?: string }
    try {
      body = (await request.json()) as { ip?: string }
    } catch {
      return new Response('Invalid body', { status: 400 })
    }
    const ip = typeof body.ip === 'string' && body.ip.length <= 64 ? body.ip : ''
    if (!ip) return new Response('Missing ip', { status: 400 })

    const key = KEY_PREFIX + ip
    if (isSuccess) {
      const state = await this.readOrReset(key)
      state.count += 1
      await this.state.storage.put(key, state)
      return new Response('OK', { status: 200 })
    }

    // /limit is a pure check: reject if already over the cap, without counting.
    const state = await this.readOrReset(key)
    if (state.count >= MAX_PER_IP_PER_HOUR) {
      return new Response('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '3600' } })
    }
    return new Response('OK', { status: 200 })
  }
}

export default Limiter
