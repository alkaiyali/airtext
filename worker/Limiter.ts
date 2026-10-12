// Counts room *creations* per network (joins and reconnects to an existing room
// are free). Token bucket: a burst for busy shared networks (offices, schools,
// carrier NAT), then a steady refill, so a throttled network recovers within
// minutes instead of being locked out for a fixed hour.
export const ROOM_BURST = 30
export const ROOM_REFILL_MS = 60 * 1000
const KEY_PREFIX = 'ip:'
// Normalized keys are IPv4 dotted quads, /64-grouped IPv6, or the /64 suffix.
const IP_RE = /^[A-Za-z0-9.:]+\/\d+$|^[0-9.]+$|^[A-Za-z0-9:]+$/

interface Bucket {
  tokens: number
  updatedAt: number
}

/** Pure helper, unit-tested: tokens available at `now`, capped at the burst.
 * Records without a token count (the old fixed-window format) count as full. */
export function refillTokens(bucket: Partial<Bucket> | undefined, now: number): number {
  if (!bucket || typeof bucket.tokens !== 'number' || typeof bucket.updatedAt !== 'number') return ROOM_BURST
  return Math.min(ROOM_BURST, bucket.tokens + Math.max(0, now - bucket.updatedAt) / ROOM_REFILL_MS)
}

export class Limiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/consume') return new Response('Not found', { status: 404 })
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    let body: { ip?: string }
    try {
      body = (await request.json()) as { ip?: string }
    } catch {
      return new Response('Invalid body', { status: 400 })
    }
    const ip = typeof body.ip === 'string' && body.ip.length > 0 && body.ip.length <= 64 && IP_RE.test(body.ip) ? body.ip : ''
    if (!ip) return new Response('Missing ip', { status: 400 })

    // Atomic check-and-consume: one call per room creation, so parallel
    // creations cannot both pass a stale check before either is counted.
    const key = KEY_PREFIX + ip
    const now = Date.now()
    const tokens = refillTokens(await this.state.storage.get<Bucket>(key), now)
    if (tokens < 1) {
      const retryAfter = Math.ceil(((1 - tokens) * ROOM_REFILL_MS) / 1000)
      return new Response('Rate limit exceeded', { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' } })
    }
    const left = tokens - 1
    await this.state.storage.put(key, { tokens: left, updatedAt: now } satisfies Bucket)
    // Forget the address once the bucket is full again: a full bucket is the
    // same as no record, so the plaintext key is never kept past its use.
    try {
      await this.state.storage.setAlarm(now + Math.ceil((ROOM_BURST - left) * ROOM_REFILL_MS))
    } catch { /* alarms unavailable in tests */ }
    return new Response('OK', { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}

export default Limiter
