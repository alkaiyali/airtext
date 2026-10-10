import Room from './Room'
import Limiter from './Limiter'

interface Env {
  ASSETS: Fetcher
  ROOMS: DurableObjectNamespace
  LIMITER: DurableObjectNamespace
}

export { Room, Limiter }

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), clipboard-read=(self), clipboard-write=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // HSTS is ignored over plain HTTP (local dev), honored over HTTPS (prod).
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
}

/** Vite emits same-origin module scripts + external CSS; images may be
 * data:/blob: (camera/gallery). Sockets are pinned to this exact host rather
 * than any wss: endpoint, so injected script cannot ship data elsewhere
 * (older Safari does not treat 'self' as covering ws/wss). */
export function contentSecurityPolicy(requestUrl: string): string {
  const { host, protocol } = new URL(requestUrl)
  const socketOrigin = `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}`
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' data: blob:; media-src blob: data:; connect-src 'self' ${socketOrigin}; ` +
    "worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; " +
    "form-action 'self'; frame-ancestors 'none'"
  )
}

function withSecurityHeaders(response: Response, requestUrl: string): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', contentSecurityPolicy(requestUrl))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** Rate-limit key for a client address. IPv6 users typically control a whole
 * /64, so keying on the full address would let one network rotate past the
 * limit; IPv4 addresses are used as-is. */
export function limiterKey(ip: string): string {
  if (!ip.includes(':')) return ip
  const [head, tail = ''] = ip.toLowerCase().split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = ip.includes('::') && tail ? tail.split(':') : []
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length)
  const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups]
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

function clientKey(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP') ?? ''
  return ip ? limiterKey(ip) : ''
}

async function enforceIpLimit(request: Request, env: Env): Promise<boolean> {
  const ip = clientKey(request)
  if (!ip || !env.LIMITER) return true
  try {
    const limiterId = env.LIMITER.idFromName(ip)
    const response = await env.LIMITER.get(limiterId).fetch('https://limiter/limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip }),
    })
    if (response.status === 429) return false
    return true
  } catch {
    return true // never block the room on a limiter failure
  }
}

async function markSuccess(request: Request, env: Env): Promise<void> {
  const ip = clientKey(request)
  if (!ip || !env.LIMITER) return
  const limiterId = env.LIMITER.idFromName(ip)
  await env.LIMITER.get(limiterId).fetch('https://limiter/success', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip }),
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleFetch(request, env, ctx)
    } catch (error) {
      // Details go to the Worker logs, never to the client.
      console.error('airtext error', error)
      return withSecurityHeaders(new Response('Something went wrong. Try again in a moment.', { status: 500 }), request.url)
    }
  },
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const roomMatch = url.pathname.match(/^\/room\/([A-Z0-9]{8})$/i)
  if (roomMatch) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return withSecurityHeaders(new Response('WebSocket upgrade required', { status: 426 }), request.url)
    }
    const allowed = await enforceIpLimit(request, env)
    if (!allowed) {
      return withSecurityHeaders(new Response('Too many rooms from this network. Try again later.', { status: 429, headers: { 'Retry-After': '3600' } }), request.url)
    }
    const roomId = env.ROOMS.idFromName(roomMatch[1].toUpperCase())
    try {
      const upgrade = await env.ROOMS.get(roomId).fetch(request)
      // Count a successful join without blocking the upgrade. waitUntil keeps
      // the Worker alive until the count lands; a bare promise can be
      // cancelled once the response is returned, silently disabling the limit.
      if (upgrade.status === 101) {
        ctx.waitUntil(markSuccess(request, env).catch(() => undefined))
      }
      return upgrade
    } catch (error) {
      console.error('airtext room error', error)
      return withSecurityHeaders(new Response('Could not open the room. Try again in a moment.', { status: 500 }), request.url)
    }
  }

  return withSecurityHeaders(await env.ASSETS.fetch(request), request.url)
}
