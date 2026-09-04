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
  // Vite emits same-origin module scripts + external CSS; images may be
  // data:/blob: (camera/gallery), sockets are same-origin wss:.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src blob: data:; connect-src 'self' wss: ws:; " +
    "worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; " +
    "form-action 'self'; frame-ancestors 'none'",
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function enforceIpLimit(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') ?? ''
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
  const ip = request.headers.get('CF-Connecting-IP') ?? ''
  if (!ip || !env.LIMITER) return
  const limiterId = env.LIMITER.idFromName(ip)
  await env.LIMITER.get(limiterId).fetch('https://limiter/success', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip }),
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return withSecurityHeaders(new Response(`airtext error: ${message}`, { status: 500 }))
    }
  },
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const roomMatch = url.pathname.match(/^\/room\/([A-Z0-9]{8})$/i)
  if (roomMatch) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return withSecurityHeaders(new Response('WebSocket upgrade required', { status: 426 }))
    }
    const allowed = await enforceIpLimit(request, env)
    if (!allowed) {
      return withSecurityHeaders(new Response('Too many rooms from this network. Try again later.', { status: 429, headers: { 'Retry-After': '3600' } }))
    }
    const roomId = env.ROOMS.idFromName(roomMatch[1].toUpperCase())
    try {
      const stub = env.ROOMS.get(roomId)
      if (!stub) return withSecurityHeaders(new Response('room error: ROOMS.get returned undefined', { status: 500 }))
      const upgrade = await stub.fetch(request)
      // Count a successful join without blocking the upgrade (fire-and-forget).
      if (upgrade.status === 101) {
        void markSuccess(request, env).catch(() => undefined)
      }
      return upgrade
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return withSecurityHeaders(new Response(`room error: ${message}`, { status: 500 }))
    }
  }

  return withSecurityHeaders(await env.ASSETS.fetch(request))
}
