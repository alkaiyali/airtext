import Room from './Room'
import Limiter from './Limiter'
import { LIMIT_KEY_HEADER } from './protocol'

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env)
    } catch (error) {
      // Details go to the Worker logs, never to the client.
      console.error('airtext error', error)
      return withSecurityHeaders(new Response('Something went wrong. Try again in a moment.', { status: 500 }), request.url)
    }
  },
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const roomMatch = url.pathname.match(/^\/room\/([A-Z0-9]{8})$/i)
  if (roomMatch) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return withSecurityHeaders(new Response('WebSocket upgrade required', { status: 426 }), request.url)
    }
    // The room decides whether this upgrade creates it (counted against the
    // network) or joins/reconnects to it (free), so it needs the network key.
    // Set it here, overwriting anything the client sent: the Room is only
    // reachable through this Worker.
    const headers = new Headers(request.headers)
    headers.set(LIMIT_KEY_HEADER, clientKey(request))
    const forwarded = new Request(request, { headers })
    const roomId = env.ROOMS.idFromName(roomMatch[1].toUpperCase())
    try {
      return await env.ROOMS.get(roomId).fetch(forwarded)
    } catch (error) {
      console.error('airtext room error', error)
      return withSecurityHeaders(new Response('Could not open the room. Try again in a moment.', { status: 500 }), request.url)
    }
  }

  return withSecurityHeaders(await env.ASSETS.fetch(request), request.url)
}
