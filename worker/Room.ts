import { encode, LIMIT_KEY_HEADER, MAX_SEALED_LENGTH, parseClientMessage, type DeviceKind } from './protocol'

interface Env {
  ROOMS: DurableObjectNamespace
  LIMITER?: DurableObjectNamespace
}

interface Attachment {
  device: DeviceKind | null
  /** Per-session secret from hello: lets a client replace its own live socket. */
  resume?: string
  connectedAt: number
  lastMessageAt: number
  lastContentAt: number
  contentTokens: number
  lastKeyExchangeAt: number
  keyExchangeTokens: number
  /** Global per-socket flood budget covering every message kind. */
  messageTokens: number
  lastRefillAt: number
  lastHelloAt: number
  lastPingAt: number
  lastControlAt: number
  /** Garbage/rate-limit strikes; the socket is shed past the cap. */
  violations: number
}

const ROOM_TTL_MS = 30 * 60 * 1000
const RATE_WINDOW_MS = 1_000
// Clipboard items: a short burst (pasting two or three things in a row) then
// one per second sustained. Each item makes the peer burn an AES-GCM decrypt.
const CONTENT_BURST = 3
const CONTENT_REFILL_PER_SECOND = 1
// The handshake sends two key-exchanges back-to-back (the offer, then the
// confirmation one round-trip later), so a flat interval drops the confirm on
// low-latency networks. Allow a small burst instead, refilling slowly: each
// message can make the peer burn an ECDH derive, so sustained traffic must
// stay capped.
const KEY_EXCHANGE_BURST = 3
const KEY_EXCHANGE_REFILL_PER_SECOND = 2
// Cap total sockets so unauthenticated connections can't exhaust memory during
// the brief overlap when a device replaces a stale socket.
const MAX_SOCKETS = 4
// Sockets that never identify themselves are closed after this long.
const HELLO_TIMEOUT_MS = 10_000
// A socket is stale if it has not sent anything for this long. Clients send a
// lightweight ping every 15s, so a live socket always has a fresh lastMessageAt.
const STALE_SOCKET_MS = 30_000
// Global flood budget: normal clients send hello + 2 key-exchanges + a ping
// every 15s + ≤1 content item/s, far below this. A sustained flood above the
// refill rate is abusive parse/CPU burn regardless of message kind.
const MESSAGE_BURST = 20
const MESSAGE_REFILL_PER_SECOND = 5
// Hello/ping/ack/clear-history each have a floor interval so one socket cannot
// flap peer-joined status, reflect pongs, or spam the peer with receipts.
const HELLO_MIN_INTERVAL_MS = 1_000
const PING_MIN_INTERVAL_MS = 1_000
const CONTROL_WINDOW_MS = 500
// Past this many garbage/rate-limit strikes the socket is closed instead of
// warned: keeps one abusive connection from burning CPU forever.
const MAX_VIOLATIONS = 10
// Recently relayed clipboard ids, so a replayed (or double-sent) id is dropped
// at the relay instead of making the peer burn an AES-GCM decrypt + ack.
const MAX_SEEN_IDS = 200

function blankAttachment(now = Date.now()): Attachment {
  return {
    device: null,
    connectedAt: now,
    lastMessageAt: now,
    lastContentAt: 0,
    contentTokens: CONTENT_BURST,
    lastKeyExchangeAt: 0,
    keyExchangeTokens: KEY_EXCHANGE_BURST,
    messageTokens: MESSAGE_BURST,
    lastRefillAt: now,
    lastHelloAt: 0,
    lastPingAt: 0,
    lastControlAt: 0,
    violations: 0,
  }
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

/** Pure helper, unit-tested: copy for a refused room creation. */
export function roomLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
  return `Too many new rooms from this network right now. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

export class Room {
  private readonly peers = new Map<WebSocket, Attachment>()
  private readonly seenClipboardIds = new Set<string>()
  /** Set once this room has been counted against its creator's network. */
  private created = false
  private creation: Promise<number> | null = null

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    // Restore peer state after hibernation so connections survive the DO
    // being evicted from memory (WebSocket Hibernation API).
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null
      this.peers.set(socket, attachment ?? blankAttachment(0))
    }
    if (this.peers.size > 0) this.created = true
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 })
    }

    if (!isOriginAllowed(request.headers.get('Origin'), request.url)) {
      return new Response('Origin rejected', { status: 403 })
    }
    if (this.peers.size >= MAX_SOCKETS) {
      // Transient during reconnect overlap: the client shows this and retries.
      return refuse(1013, 'room_full', 'This room is busy. Close any other airtext tabs and try again.')
    }
    const retryAfter = await this.admit(request.headers.get(LIMIT_KEY_HEADER) ?? '')
    if (retryAfter > 0) return refuse(4429, 'room_limit', roomLimitMessage(retryAfter))

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

  /** The first upgrade into a room creates it and is counted against the
   * caller's network; joins and reconnects to an existing room are free.
   * Returns 0 when admitted, else seconds until the network may create again. */
  async admit(limitKey: string): Promise<number> {
    if (this.created) return 0
    // Memoized so parallel first upgrades share one claim instead of each
    // consuming a token.
    this.creation ??= this.claimCreation(limitKey)
    const retryAfter = await this.creation
    if (retryAfter > 0) this.creation = null
    return retryAfter
  }

  private async claimCreation(limitKey: string): Promise<number> {
    const existing = await this.state.storage.get<boolean>('created').catch(() => undefined)
    if (!existing) {
      const retryAfter = await this.consumeCreation(limitKey)
      if (retryAfter > 0) return retryAfter
      await this.state.storage.put('created', true).catch(() => undefined)
    }
    this.created = true
    return 0
  }

  private async consumeCreation(limitKey: string): Promise<number> {
    if (!limitKey || !this.env.LIMITER) return 0
    try {
      const limiter = this.env.LIMITER.get(this.env.LIMITER.idFromName(limitKey))
      const response = await limiter.fetch('https://limiter/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: limitKey }),
      })
      if (response.status !== 429) return 0
      return Math.max(1, Number(response.headers.get('Retry-After')) || 60)
    } catch {
      return 0 // never block the room on a limiter failure
    }
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let attachment = this.peers.get(socket)
    if (!attachment) {
      attachment = blankAttachment(0)
      this.peers.set(socket, attachment)
    }
    const now = Date.now()
    // Every message counts as liveness, so the hello handler can tell a live
    // socket apart from a stale one.
    attachment.lastMessageAt = now
    // Global flood budget first, before JSON.parse burns CPU: refill then
    // consume one token per message. Restored/hibernated attachments without a
    // budget are treated as full.
    const refilled = Math.min(
      MESSAGE_BURST,
      (attachment.messageTokens ?? MESSAGE_BURST) +
        ((now - (attachment.lastRefillAt ?? now)) / RATE_WINDOW_MS) * MESSAGE_REFILL_PER_SECOND,
    )
    if (refilled < 1) {
      this.noteViolation(socket, attachment, 'rate_limited', 'Too many messages. Slow down and try again.')
      return
    }
    attachment.messageTokens = refilled - 1
    attachment.lastRefillAt = now
    this.persist(socket, attachment)
    if (typeof raw !== 'string' || raw.length > MAX_SEALED_LENGTH + 512) {
      this.noteViolation(socket, attachment, 'payload_too_large', 'This clipboard item is too large.')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.noteViolation(socket, attachment, 'invalid_json', 'The room could not read that data. Try sharing again.')
      return
    }
    const message = parseClientMessage(parsed)
    if (!message) {
      this.noteViolation(socket, attachment, 'invalid_message', 'The room did not understand that message. Try sharing again.')
      return
    }
    if (message.type === 'hello') {
      if (now - (attachment.lastHelloAt ?? 0) < HELLO_MIN_INTERVAL_MS) {
        this.noteViolation(socket, attachment, 'rate_limited', 'Too many messages. Slow down and try again.')
        return
      }
      attachment.lastHelloAt = now
      this.persist(socket, attachment)
      const previousDevice = attachment.device
      // A live socket for this device may only be replaced by the same client
      // reconnecting (matching resume token). Anyone else holding the room
      // code — a second tab, or an attacker — must wait for it to go stale,
      // so knowing the code is not enough to kick a connected device out.
      const sameDevice = [...this.peers].filter(([other, existing]) => other !== socket && existing.device === message.device)
      const blocked = sameDevice.some(([, existing]) => {
        const stale = now - existing.lastMessageAt > STALE_SOCKET_MS
        const sameClient = message.resume !== undefined && existing.resume === message.resume
        return !stale && !sameClient
      })
      if (blocked) {
        this.sendError(socket, 'device_in_use', 'This room already has this device connected. Close the other tab and try again.')
        this.peers.delete(socket)
        try { socket.close(1011, 'device_in_use') } catch { /* already closed */ }
        return
      }
      for (const [other] of sameDevice) {
        this.peers.delete(other)
        try { other.close(1011, 'replaced') } catch { /* already closed */ }
      }
      attachment.device = message.device
      attachment.resume = message.resume
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
      if (now - (attachment.lastPingAt ?? 0) < PING_MIN_INTERVAL_MS) {
        this.noteViolation(socket, attachment, 'rate_limited', 'Too many messages. Slow down and try again.')
        return
      }
      attachment.lastPingAt = now
      this.persist(socket, attachment)
      socket.send(encode({ type: 'pong', timestamp: message.timestamp }))
      return
    }
    if (message.type === 'clipboard-item') {
      // Token bucket like key-exchange; older attachments count as full.
      const contentTokens = Math.min(
        CONTENT_BURST,
        (attachment.contentTokens ?? CONTENT_BURST) + ((now - (attachment.lastContentAt ?? 0)) / RATE_WINDOW_MS) * CONTENT_REFILL_PER_SECOND,
      )
      if (contentTokens < 1) {
        this.noteViolation(socket, attachment, 'rate_limited', 'Too many messages. Slow down and try again.')
        return
      }
      attachment.contentTokens = contentTokens - 1
      attachment.lastContentAt = now
      this.persist(socket, attachment)
      if (!attachment.device) {
        this.sendError(socket, 'not_ready', 'Identify this device before sharing text.')
        return
      }
      if (this.seenClipboardIds.has(message.id)) {
        this.noteViolation(socket, attachment, 'duplicate', 'This item was already shared.')
        return
      }
      this.rememberClipboardId(message.id)
      this.broadcast({ ...message, type: 'clipboard-item', source: attachment.device }, socket)
    }
    if (message.type === 'key-exchange') {
      // Token bucket: restores keyExchangeTokens per second, never above the
      // burst capacity. Attachments restored from an older format have no
      // token count, so treat them as full.
      const tokens = Math.min(
        KEY_EXCHANGE_BURST,
        (attachment.keyExchangeTokens ?? KEY_EXCHANGE_BURST) + ((now - (attachment.lastKeyExchangeAt ?? 0)) / RATE_WINDOW_MS) * KEY_EXCHANGE_REFILL_PER_SECOND,
      )
      if (tokens < 1) {
        this.noteViolation(socket, attachment, 'rate_limited', 'Too many messages. Slow down and try again.')
        return
      }
      attachment.keyExchangeTokens = tokens - 1
      attachment.lastKeyExchangeAt = now
      this.persist(socket, attachment)
      // Gate on hello like clipboard items: unauthenticated sockets must not
      // be able to make the peer burn ECDH derives.
      if (!attachment.device) {
        this.sendError(socket, 'not_ready', 'Identify this device before exchanging keys.')
        return
      }
      this.broadcast({ ...message, type: 'key-exchange', source: attachment.device }, socket)
    }
    // Everything below is peer-to-peer traffic: unidentified sockets must not
    // be able to forge delivery receipts or wipe the other side's history.
    if ((message.type === 'ack' || message.type === 'clear-history') && !attachment.device) {
      this.sendError(socket, 'not_ready', 'Identify this device before sending messages.')
      return
    }
    if (message.type === 'ack' || message.type === 'clear-history') {
      if (now - (attachment.lastControlAt ?? 0) < CONTROL_WINDOW_MS) {
        this.noteViolation(socket, attachment, 'rate_limited', 'Too many messages. Slow down and try again.')
        return
      }
      attachment.lastControlAt = now
      this.persist(socket, attachment)
    }
    if (message.type === 'ack') {
      this.broadcast({ type: 'ack', id: message.id }, socket)
    }
    if (message.type === 'clear-history') {
      this.broadcast({ type: 'clear-history', sealed: message.sealed }, socket)
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
    await this.scheduleNextAlarm()
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
      // The room is gone: a later upgrade with this code creates (and is
      // counted as) a new room.
      this.created = false
      this.creation = null
      await this.state.storage.deleteAll()
      return
    }
    await this.scheduleNextAlarm()
  }

  /** Wake only when there is work: reap an empty room, or sweep sockets that
   * have not said hello yet. Fully identified rooms stay hibernated. */
  private async scheduleNextAlarm(): Promise<void> {
    if (this.peers.size === 0) {
      await this.scheduleAlarm(ROOM_TTL_MS)
      return
    }
    for (const attachment of this.peers.values()) {
      if (!attachment.device) {
        await this.scheduleAlarm(HELLO_TIMEOUT_MS)
        return
      }
    }
  }

  private persist(socket: WebSocket, attachment: Attachment): void {
    socket.serializeAttachment(attachment)
  }

  private rememberClipboardId(id: string): void {
    if (this.seenClipboardIds.size >= MAX_SEEN_IDS) {
      const oldest = this.seenClipboardIds.values().next().value
      if (oldest !== undefined) this.seenClipboardIds.delete(oldest)
    }
    this.seenClipboardIds.add(id)
  }

  /** Warn then shed: garbage/flood strikes accumulate per socket so one abusive
   * connection cannot burn relay CPU forever. not_ready/device_in_use are
   * legitimate races and never count here. */
  private noteViolation(socket: WebSocket, attachment: Attachment, code: string, message: string): void {
    this.sendError(socket, code, message)
    attachment.violations = (attachment.violations ?? 0) + 1
    this.persist(socket, attachment)
    if (attachment.violations >= MAX_VIOLATIONS) {
      this.peers.delete(socket)
      try { socket.close(1011, 'abuse') } catch { /* already closed */ }
    }
  }

  private broadcast(message: Parameters<typeof encode>[0], except?: WebSocket): void {
    const data = encode(message)
    this.peers.forEach((attachment, key) => {
      // Sockets that have not said hello get nothing relayed to them.
      if (key === except || !attachment.device) return
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

/** Accept just long enough to explain why, then close: browsers hide the HTTP
 * status of a failed upgrade, so a plain 429 reads as "can't connect". */
function refuse(closeCode: number, code: string, message: string): Response {
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
  server.accept()
  server.send(encode({ type: 'error', code, message }))
  server.close(closeCode, code)
  return new Response(null, { status: 101, webSocket: client })
}

export default Room
