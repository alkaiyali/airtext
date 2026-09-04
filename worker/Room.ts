import { encode, MAX_SEALED_LENGTH, parseClientMessage, type DeviceKind } from './protocol'

interface Env {
  ROOMS: DurableObjectNamespace
}

interface Attachment {
  device: DeviceKind | null
  connectedAt: number
  lastMessageAt: number
  lastContentAt: number
  lastKeyExchangeAt: number
}

const ROOM_TTL_MS = 30 * 60 * 1000
const MAX_RATE_PER_SECOND = 1
const RATE_WINDOW_MS = 1_000
// Key-exchange bursts are tiny (pubkey + one confirmation round-trip) but each
// one makes the peer burn an ECDH derive, so it gets its own small bucket
// instead of sharing the clipboard budget.
const MAX_KEY_EXCHANGE_PER_SECOND = 5
// Cap total sockets so unauthenticated connections can't exhaust memory during
// the brief overlap when a device replaces a stale socket.
const MAX_SOCKETS = 4
// Sockets that never identify themselves are closed after this long.
const HELLO_TIMEOUT_MS = 10_000
// A socket is stale if it has not sent anything for this long. Clients send a
// lightweight ping every 15s, so a live socket always has a fresh lastMessageAt.
const STALE_SOCKET_MS = 30_000
// After replacing a device's socket, reject re-joins from the replaced client
// for this long. The client retries with backoff, so a cooldown lets the loser
// give up instead of re-replacing the winner and ping-ponging forever.
const REPLACE_COOLDOWN_MS = 60_000

function blankAttachment(now = Date.now()): Attachment {
  return { device: null, connectedAt: now, lastMessageAt: now, lastContentAt: 0, lastKeyExchangeAt: 0 }
}

/** Pure helper, unit-tested: same-origin or missing origin passes. */
export function isOriginAllowed(origin: string | null, requestUrl: string): boolean {
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(requestUrl).host
  } catch {
    return false
  }
}

/** Pure helper, unit-tested: only announce when a device newly registers. */
export function shouldAnnounceJoin(previousDevice: DeviceKind | null, nextDevice: DeviceKind): boolean {
  return previousDevice !== nextDevice
}

export class Room {
  private readonly peers = new Map<WebSocket, Attachment>()
  private readonly replaceCooldowns = new Map<DeviceKind, number>()

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    // Restore peer state after hibernation so connections survive the DO
    // being evicted from memory (WebSocket Hibernation API).
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null
      this.peers.set(socket, attachment ?? blankAttachment(0))
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 })
    }

    if (!isOriginAllowed(request.headers.get('Origin'), request.url)) {
      return new Response('Origin rejected', { status: 403 })
    }
    if (this.peers.size >= MAX_SOCKETS) {
      return new Response('Room is full. Close the other tab and try again.', { status: 429 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    // Hibernation API: registers the socket with the runtime so the Durable
    // Object can be evicted while keeping the connection alive. Do NOT call
    // server.accept() or addEventListener here.
    this.state.acceptWebSocket(server)
    // Count peers before adding this socket so the new client never sees an
    // inflated count while a stale socket from the same device is still
    // registered; the hello handler corrects the count and announces the join
    // once the client identifies itself.
    const peerCount = this.peers.size
    this.peers.set(server, blankAttachment())
    await this.scheduleAlarm(HELLO_TIMEOUT_MS)

    server.send(encode({ type: 'hello', version: 1, peers: peerCount }))

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let attachment = this.peers.get(socket)
    if (!attachment) {
      attachment = blankAttachment(0)
      this.peers.set(socket, attachment)
    }
    // Every message counts as liveness, so the hello handler can tell a live
    // socket apart from a stale one.
    attachment.lastMessageAt = Date.now()
    this.persist(socket, attachment)
    if (typeof raw !== 'string' || raw.length > MAX_SEALED_LENGTH + 512) {
      this.sendError(socket, 'payload_too_large', 'This clipboard item is too large.')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.sendError(socket, 'invalid_json', 'The room received invalid data.')
      return
    }
    const message = parseClientMessage(parsed)
    if (!message) {
      this.sendError(socket, 'invalid_message', 'The room received an unsupported message.')
      return
    }
    // Rate-limit only content messages (clipboard items); hello/ping are
    // lightweight keepalives and must never be throttled.
    if (message.type === 'clipboard-item') {
      const now = Date.now()
      if (now - attachment.lastContentAt < RATE_WINDOW_MS / MAX_RATE_PER_SECOND) {
        this.sendError(socket, 'rate_limited', 'Too many messages. Slow down and try again.')
        return
      }
      attachment.lastContentAt = now
      this.persist(socket, attachment)
    }
    if (message.type === 'key-exchange') {
      const now = Date.now()
      if (now - attachment.lastKeyExchangeAt < RATE_WINDOW_MS / MAX_KEY_EXCHANGE_PER_SECOND) {
        this.sendError(socket, 'rate_limited', 'Too many messages. Slow down and try again.')
        return
      }
      attachment.lastKeyExchangeAt = now
      this.persist(socket, attachment)
    }
    if (message.type === 'hello') {
      const now = Date.now()
      const previousDevice = attachment.device
      // Only replace a socket that is actually stale (has not sent anything
      // recently). Two live sockets for the same device (e.g. two tabs) must
      // not trade kills forever, and a client retrying after being replaced
      // must not immediately re-replace the winner.
      for (const [other, existing] of this.peers) {
        if (other === socket || existing.device !== message.device) continue
        const stale = now - existing.lastMessageAt > STALE_SOCKET_MS
        const inCooldown = now < (this.replaceCooldowns.get(message.device) ?? 0)
        if (!stale && inCooldown) {
          this.sendError(socket, 'device_in_use', 'This room already has this device connected. Close the other tab and try again.')
          this.peers.delete(socket)
          try { socket.close(1011, 'device_in_use') } catch { /* already closed */ }
          return
        }
        this.peers.delete(other)
        this.replaceCooldowns.set(message.device, now + REPLACE_COOLDOWN_MS)
        try { other.close(1011, 'replaced') } catch { /* already closed */ }
      }
      attachment.device = message.device
      this.persist(socket, attachment)
      socket.send(encode({ type: 'hello', version: 1, peers: this.peers.size }))
      // Re-hellos from the same socket (e.g. after a DO restart re-register)
      // must not flap the peer: only announce genuinely new joins.
      if (shouldAnnounceJoin(previousDevice, message.device)) {
        this.broadcast({ type: 'peer-joined', peers: this.peers.size }, socket)
      }
      return
    }
    if (message.type === 'ping') {
      socket.send(encode({ type: 'pong', timestamp: message.timestamp }))
      return
    }
    if (message.type === 'clipboard-item') {
      if (!attachment.device) {
        this.sendError(socket, 'not_ready', 'Identify this device before sharing text.')
        return
      }
      this.broadcast({ ...message, type: 'clipboard-item', source: attachment.device }, socket)
    }
    if (message.type === 'key-exchange') {
      // Gate on hello like clipboard items: unauthenticated sockets must not
      // be able to make the peer burn ECDH derives.
      if (!attachment.device) {
        this.sendError(socket, 'not_ready', 'Identify this device before exchanging keys.')
        return
      }
      this.broadcast({ ...message, type: 'key-exchange', source: attachment.device }, socket)
    }
    if (message.type === 'ack') {
      this.broadcast({ type: 'ack', id: message.id }, socket)
    }
    if (message.type === 'clear-history') {
      this.broadcast({ type: 'clear-history' }, socket)
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    // With web_socket_auto_reply_to_close the runtime already completed the
    // close handshake; close() is not required. Only announce departures of
    // peers that were actually connected: a stale socket removed by the hello
    // replacement logic (or dropped by broadcast) was already accounted for,
    // and announcing it again would make the other peer flip back to "waiting"
    // on every reconnect.
    const wasPresent = this.peers.delete(socket)
    if (!wasPresent) return
    this.broadcast({ type: 'peer-left', peers: this.peers.size })
    await this.scheduleAlarm(this.peers.size === 0 ? ROOM_TTL_MS : HELLO_TIMEOUT_MS)
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket)
  }

  /** Storage alarm survives eviction (unlike setTimeout): sweeps hello-less
   * sockets and reaps idle rooms. */
  async alarm(): Promise<void> {
    const now = Date.now()
    for (const [socket, attachment] of this.peers) {
      if (!attachment.device && now - attachment.connectedAt > HELLO_TIMEOUT_MS) {
        this.peers.delete(socket)
        try { socket.close(1011, 'hello_timeout') } catch { /* already closed */ }
      }
    }
    if (this.peers.size === 0) {
      await this.state.storage.deleteAll()
      return
    }
    await this.scheduleAlarm(HELLO_TIMEOUT_MS)
  }

  private persist(socket: WebSocket, attachment: Attachment): void {
    socket.serializeAttachment(attachment)
  }

  private broadcast(message: Parameters<typeof encode>[0], except?: WebSocket): void {
    const data = encode(message)
    this.peers.forEach((_attachment, key) => {
      if (key === except) return
      try {
        key.send(data)
      } catch {
        // Dead socket: drop it so it can't poison future broadcasts.
        this.peers.delete(key)
      }
    })
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    try {
      socket.send(encode({ type: 'error', code, message }))
    } catch { /* socket already gone */ }
  }

  private async scheduleAlarm(inMs: number): Promise<void> {
    try {
      await this.state.storage.setAlarm(Date.now() + inMs)
    } catch { /* alarms unavailable in tests */ }
  }
}

export default Room
