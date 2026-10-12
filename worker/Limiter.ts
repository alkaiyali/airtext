// Room creation is rare (one per pairing): 60 joins/hour/IP is generous for
// normal use while bounding room-spam and code-enumeration from one network.
export const MAX_PER_IP_PER_HOUR = 60
export const WINDOW_MS = 60 * 60 * 1000
const KEY_PREFIX = 'ip:'
// Normalized keys are IPv4 dotted quads, /64-grouped IPv6, or the /64 suffix.
const IP_RE = /^[A-Za-z0-9.:]+\/\d+$|^[0-9.]+$|^[A-Za-z0-9:]+$/

interface RateState {
  count: number
  windowStart: number
}

export class Limiter {
  constructor(private readonly state: DurableObjectState) {}

  private async readOrReset(key: string): Promise<RateState> {
    const now = Date.now()
    const existing = await this.state.storage.get<RateState>(key)
    if (!existing) return { count: 0, windowStart: now }
    if (now - existing.windowStart >= WINDOW_MS) {
      // Window expired: drop the key so plaintext IPs are not retained past
      // their useful life, then start fresh.
      await this.state.storage.delete(key).catch(() => undefined)
      return { count: 0, windowStart: now }
    }
    return existing
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const isSuccess = url.pathname === '/success'
    const isConsume = url.pathname === '/consume'
    if (!isSuccess && !isConsume && url.pathname !== '/limit') return new Response('Not found', { status: 404 })
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    let body: { ip?: string }
    try {
      body = (await request.json()) as { ip?: string }
    } catch {
      return new Response('Invalid body', { status: 400 })
    }
    const ip = typeof body.ip === 'string' && body.ip.length > 0 && body.ip.length <= 64 && IP_RE.test(body.ip) ? body.ip : ''
    if (!ip) return new Response('Missing ip', { status: 400 })

    const key = KEY_PREFIX + ip
    if (isConsume) {
      // Atomic check-and-increment: one call per upgrade attempt, so parallel
      // joins cannot both pass a stale check before either increments.
      const state = await this.readOrReset(key)
      if (state.count >= MAX_PER_IP_PER_HOUR) {
        return new Response('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '3600', 'Cache-Control': 'no-store' } })
      }
      state.count += 1
      await this.state.storage.put(key, state)
      return new Response('OK', { status: 200, headers: { 'Cache-Control': 'no-store' } })
    }
    if (isSuccess) {
      const state = await this.readOrReset(key)
      state.count += 1
      await this.state.storage.put(key, state)
      return new Response('OK', { status: 200 })
    }

    // /limit is a pure check: reject if already over the cap, without counting.
    // Persist a reset window so expiry is not stuck in storage.
    const state = await this.readOrReset(key)
    if (state.count >= MAX_PER_IP_PER_HOUR) {
      return new Response('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '3600' } })
    }
    if (state.count === 0) {
      await this.state.storage.put(key, state).catch(() => undefined)
    }
    return new Response('OK', { status: 200 })
  }
}

export default Limiter
