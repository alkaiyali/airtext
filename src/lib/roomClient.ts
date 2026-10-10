import type { ClientMessage, DeviceKind, ServerMessage } from '../types'
import { isServerMessage, MAX_SEALED_LENGTH } from '../types'
import {
  deriveSession,
  exportPublicKey,
  generateKeyPair,
  makeConfirm,
  open,
  seal,
  verifyConfirm,
  type SessionKeys,
} from './crypto'

export type RoomClientEvent =
  | { type: 'status'; status: 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'error'; message?: string }
  | { type: 'server'; message: ServerMessage }
  | { type: 'decrypted'; payload: { id: string; text: string; createdAt: number; image?: string; kind?: 'text' | 'image' } }
  | { type: 'delivered'; id: string }
  | { type: 'secure'; fingerprint: string }
  | { type: 'unsecure' }
  /** The paired peer cleared history (verified under the session key). */
  | { type: 'cleared' }

type ClipboardPayload = { text: string; image?: string; kind?: 'text' | 'image' }

const BASE_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 15_000
const KEEPALIVE_MS = 15_000
// A hung upgrade (captive portal, dead network) fires neither error nor close,
// so without this the UI would sit on "Connecting" forever.
const CONNECT_TIMEOUT_MS = 10_000
// Unacknowledged items are resent after the channel re-secures (a drop can
// lose an item in flight). Spaced just over the relay's 1 item/second limit.
const MAX_OUTBOX = 20
const RESEND_SPACING_MS = 1_100

export type SocketFactory = (url: string) => WebSocket

export class RoomClient {
  private socket: WebSocket | null = null
  private readonly listeners = new Set<(event: RoomClientEvent) => void>()
  private pingTimer: number | undefined
  private reconnectTimer: number | undefined
  private connectTimer: number | undefined
  private reconnectAttempts = 0
  private manuallyClosed = false
  // Ephemeral identity: fresh keypair per connect(), reused across reconnects
  // of the same session so re-opens re-derive identical keys without flapping.
  private keyPair: CryptoKeyPair | null = null
  private ownPublicKey = ''
  private peerPublicKey: string | null = null
  private session: SessionKeys | null = null
  private prevSession: SessionKeys | null = null
  private secure = false
  private exchangeSeq = 0
  private readonly outbox = new Map<string, { createdAt: number; payload: ClipboardPayload }>()
  private resendQueue: string[] = []
  private resendTimer: number | undefined
  // Replayed clear-history controls (same sealed bytes) are ignored.
  private readonly seenClears = new Set<string>()

  constructor(
    private readonly code: string,
    private readonly device: DeviceKind,
    private readonly createSocket: SocketFactory = (url) => new WebSocket(url),
    /** Sent in hello: proves to the relay that a reconnect is this same client,
     * so it may replace its own still-live socket. Others must wait it out. */
    private readonly resumeToken: string = crypto.randomUUID(),
  ) {}

  subscribe(listener: (event: RoomClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  connect(): void {
    this.manuallyClosed = false
    this.reconnectAttempts = 0
    this.resetCrypto()
    void generateKeyPair().then((pair) => {
      if (this.manuallyClosed) return
      this.keyPair = pair
      // If the socket already opened before keygen finished, introduce now.
      if (this.socket && !this.ownPublicKey) void this.sendIntroduction()
    })
    this.openSocket()
  }

  /** Manual retry after the link drops: resets backoff and reconnects now. */
  retry(): void {
    this.manuallyClosed = false
    this.clearReconnect()
    this.reconnectAttempts = 0
    this.exchangeSeq += 1
    // The close event below is ignored (socket is nulled first), so drop the
    // secure badge explicitly; the next introduction re-establishes it.
    this.markUnsecure()
    this.socket?.close()
    this.socket = null
    this.openSocket()
  }

  isOpen(): boolean {
    const readyState = this.socket?.readyState
    return readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING
  }

  isSecure(): boolean {
    return this.secure
  }

  private openSocket(): void {
    this.clearPing()
    this.emit({ type: 'status', status: 'connecting' })
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socketUrl = `${protocol}//${window.location.host}/room/${encodeURIComponent(this.code)}`
    const socket = this.createSocket(socketUrl)
    this.socket = socket
    this.clearConnectTimer()
    this.connectTimer = window.setTimeout(() => {
      if (socket !== this.socket || socket.readyState !== WebSocket.CONNECTING) return
      this.connectTimer = undefined
      // Detach before closing so this socket's close event can't schedule a
      // second reconnect, then back off like any other drop: a hung upgrade
      // is usually a dead network that comes back on its own.
      this.socket = null
      this.clearPing()
      socket.close()
      this.markUnsecure()
      this.scheduleReconnect('Could not reach the room. Retrying…')
    }, CONNECT_TIMEOUT_MS)

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return
      this.clearConnectTimer()
      this.reconnectAttempts = 0
      this.emit({ type: 'status', status: this.device === 'desktop' ? 'waiting' : 'connecting' })
      // Ping (not hello) keeps the socket fresh: the server counts any message
      // as liveness, and hello would re-broadcast peer-joined and flap status.
      this.clearPing()
      this.pingTimer = window.setInterval(() => {
        this.send({ type: 'ping', timestamp: Date.now() })
      }, KEEPALIVE_MS)
      void this.sendIntroduction()
    })

    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) return
      void this.onMessage(event.data as string)
    })

    socket.addEventListener('close', () => {
      if (socket !== this.socket) return
      this.clearConnectTimer()
      this.clearPing()
      // A deliberate close() (e.g. leaving the room or reconnecting with a new
      // socket) must not emit "disconnected": the UI would flash an error and
      // a "Start over" button while the new connection is still forming.
      if (this.manuallyClosed) return
      this.markUnsecure()
      this.emit({ type: 'status', status: 'disconnected' })
      this.scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      if (socket !== this.socket) return
      if (this.manuallyClosed) return
      this.emit({ type: 'status', status: 'error', message: 'Could not reach this room. Check your connection, then try again.' })
    })
  }

  /** hello first (the relay gates everything on it), then our exchange offer. */
  private async sendIntroduction(): Promise<void> {
    if (!this.keyPair || !this.socket) return
    if (!this.ownPublicKey) {
      try {
        this.ownPublicKey = await exportPublicKey(this.keyPair)
      } catch {
        return
      }
      if (!this.socket) return
    }
    this.send({ type: 'hello', version: 1, device: this.device, resume: this.resumeToken })
    // On re-opens the peer may already know us: attach a confirmation so both
    // sides converge without waiting another round trip.
    let confirm: string | undefined
    if (this.peerPublicKey && this.session) {
      try {
        confirm = await makeConfirm(this.session.confirmKey, this.ownPublicKey)
      } catch {
        confirm = undefined
      }
    }
    this.send({
      type: 'key-exchange',
      id: crypto.randomUUID(),
      publicKey: this.ownPublicKey,
      ...(confirm ? { confirm } : {}),
      createdAt: Date.now(),
    })
  }

  private async onKeyExchange(message: Extract<ServerMessage, { type: 'key-exchange' }>): Promise<void> {
    if (!this.keyPair || !this.ownPublicKey) return
    const seen = ++this.exchangeSeq
    if (message.publicKey === this.peerPublicKey) {
      // Re-announcement of the known key: verify a confirmation if offered.
      if (message.confirm && !this.secure && this.session) {
        try {
          if (await verifyConfirm(this.session.confirmKey, message.publicKey, message.confirm)) {
            if (seen === this.exchangeSeq) this.markSecure()
          }
        } catch { /* fail closed: stay unsecure */ }
      }
      return
    }
    let session: SessionKeys
    try {
      session = await deriveSession(this.keyPair, message.publicKey, this.code)
    } catch {
      return // malformed or off-curve key — ignore
    }
    // Superseded by a newer exchange, a retry, or close while deriving.
    if (seen !== this.exchangeSeq || this.manuallyClosed) return
    this.prevSession = this.session
    this.session = session
    this.peerPublicKey = message.publicKey
    this.markUnsecure()
    // Answer with our own key plus proof we derived the same secret.
    let confirm: string | undefined
    try {
      confirm = await makeConfirm(session.confirmKey, this.ownPublicKey)
    } catch {
      return
    }
    if (seen !== this.exchangeSeq || this.manuallyClosed) return
    this.send({
      type: 'key-exchange',
      id: crypto.randomUUID(),
      publicKey: this.ownPublicKey,
      confirm,
      createdAt: Date.now(),
    })
    if (message.confirm) {
      try {
        if (await verifyConfirm(session.confirmKey, message.publicKey, message.confirm)) {
          if (seen === this.exchangeSeq) this.markSecure()
        }
      } catch { /* fail closed */ }
    }
  }

  private markSecure(): void {
    if (this.secure || !this.session) return
    this.secure = true
    this.emit({ type: 'secure', fingerprint: this.session.verifyCode })
    this.queueResend()
  }

  private markUnsecure(): void {
    this.clearResend()
    if (!this.secure) return
    this.secure = false
    this.emit({ type: 'unsecure' })
  }

  /** Resend everything still unacknowledged, one item per relay rate window. */
  private queueResend(): void {
    this.clearResend()
    this.resendQueue = [...this.outbox.keys()]
    if (this.resendQueue.length > 0) this.resendTimer = window.setTimeout(() => void this.resendNext(), RESEND_SPACING_MS)
  }

  private async resendNext(): Promise<void> {
    this.resendTimer = undefined
    const id = this.resendQueue.shift()
    if (id === undefined) return
    const item = this.outbox.get(id)
    if (item && this.secure && this.session && this.socket?.readyState === WebSocket.OPEN) {
      try {
        await this.sealAndSend(id, item.createdAt, item.payload)
      } catch { /* stays in the outbox for the next re-secure */ }
    }
    if (this.resendQueue.length > 0 && this.secure && this.resendTimer === undefined) {
      this.resendTimer = window.setTimeout(() => void this.resendNext(), RESEND_SPACING_MS)
    }
  }

  private clearResend(): void {
    if (this.resendTimer !== undefined) window.clearTimeout(this.resendTimer)
    this.resendTimer = undefined
    this.resendQueue = []
  }

  private resetCrypto(): void {
    this.keyPair = null
    this.ownPublicKey = ''
    this.peerPublicKey = null
    this.session = null
    this.prevSession = null
    this.secure = false
    this.exchangeSeq += 1
  }

  private async onMessage(raw: string): Promise<void> {
    try {
      const message: unknown = JSON.parse(raw)
      if (!isServerMessage(message)) {
        this.emit({ type: 'status', status: 'error', message: 'The room sent an unreadable message.' })
        return
      }
      if (message.type === 'hello' || message.type === 'peer-joined') {
        if (message.peers === 2) this.emit({ type: 'status', status: 'connected' })
        else {
          this.markUnsecure()
          this.emit({ type: 'status', status: 'waiting' })
        }
      }
      if (message.type === 'peer-left') {
        // Count-aware: during a reconnect the old socket can be closed before
        // the new one's hello registers, so a "peer-left peers=2" arrives even
        // though both peers are still present. Only drop to "waiting" when a
        // peer actually left.
        if (message.peers === 2) {
          this.emit({ type: 'status', status: 'connected' })
        } else {
          this.markUnsecure()
          this.emit({ type: 'status', status: 'waiting' })
        }
      }
      if (message.type === 'pong') {
        this.emit({ type: 'server', message })
        return
      }
      if (message.type === 'key-exchange') {
        await this.onKeyExchange(message)
        this.emit({ type: 'server', message })
        return
      }
      if (message.type === 'error') {
        // The server's rate-limit message is actionable already; add the one
        // number that turns "slow down" into a concrete wait.
        const text = message.message.startsWith('Too many messages')
          ? `${message.message} You can share about one item per second.`
          : message.message
        this.emit({ type: 'status', status: 'error', message: text })
        // A definitive rejection (another live socket owns this device) should
        // not be retried forever: the server keeps a cooldown anyway, and a
        // loser that keeps reconnecting would keep re-replacing the winner.
        if (message.code === 'device_in_use') this.stopRetrying()
        // A throttled item never reached the peer; retry what is unacknowledged.
        if (message.code === 'rate_limited' && this.secure && this.resendTimer === undefined) this.queueResend()
      }
      if (message.type === 'clear-history') {
        // Only a peer holding the session key can clear our history: the relay
        // or a third party with the room code cannot forge or replay this.
        const plaintext = await this.openSealed(message.sealed)
        if (plaintext === null) return
        const control = JSON.parse(plaintext) as { type?: unknown; id?: unknown }
        if (control.type !== 'clear-history' || typeof control.id !== 'string' || this.seenClears.has(control.id)) return
        this.seenClears.add(control.id)
        this.emit({ type: 'cleared' })
        return
      }
      if (message.type === 'clipboard-item') {
        const plaintext = await this.openSealed(message.sealed)
        if (plaintext !== null) {
          this.emit({
            type: 'decrypted',
            // Fall back to the outer message's metadata for old-format senders
            // that did not seal id/createdAt inside the payload.
            payload: { ...JSON.parse(plaintext), id: message.id, createdAt: message.createdAt },
          })
          // Acknowledge delivery so the sender can mark the item as delivered.
          this.send({ type: 'ack', id: message.id })
        }
      }
      if (message.type === 'ack') {
        this.outbox.delete(message.id)
        this.emit({ type: 'delivered', id: message.id })
      }
      this.emit({ type: 'server', message })
    } catch {
      this.emit({ type: 'status', status: 'error', message: 'The room sent unreadable data.' })
    }
  }

  /** Try the current session key, then the previous one (rotation race). */
  private async openSealed(sealed: string): Promise<string | null> {
    if (this.session) {
      const plaintext = await open(this.session.messageKey, sealed)
      if (plaintext !== null) return plaintext
    }
    if (this.prevSession) {
      return await open(this.prevSession.messageKey, sealed)
    }
    return null
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  async sendClipboardItem(id: string, createdAt: number, payload: ClipboardPayload): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('The room is reconnecting — try again in a moment.')
    }
    if (!this.secure || !this.session) {
      throw new Error('Setting up the secure channel — try again in a moment.')
    }
    await this.sealAndSend(id, createdAt, payload)
    // Held until the peer acks, so a drop mid-flight doesn't lose the item.
    this.outbox.set(id, { createdAt, payload })
    if (this.outbox.size > MAX_OUTBOX) this.outbox.delete(this.outbox.keys().next().value!)
  }

  private async sealAndSend(id: string, createdAt: number, payload: ClipboardPayload): Promise<void> {
    if (!this.session) throw new Error('Setting up the secure channel — try again in a moment.')
    const sealedPayload = await seal(this.session.messageKey, JSON.stringify({ ...payload, id, createdAt }))
    if (sealedPayload.length > MAX_SEALED_LENGTH) {
      throw new Error('This item is too large to share in one piece.')
    }
    this.send({ type: 'clipboard-item', id, sealed: sealedPayload, createdAt })
  }

  /** Ask the peer to clear its history. Sealed so only the paired device can
   * send it; returns false when there is no secure channel to send over. */
  async sendClearHistory(): Promise<boolean> {
    if (!this.secure || !this.session || this.socket?.readyState !== WebSocket.OPEN) return false
    const sealed = await seal(this.session.messageKey, JSON.stringify({ type: 'clear-history', id: crypto.randomUUID(), createdAt: Date.now() }))
    this.send({ type: 'clear-history', sealed })
    return true
  }

  close(): void {
    this.manuallyClosed = true
    this.clearPing()
    this.clearReconnect()
    this.clearConnectTimer()
    this.clearResend()
    this.outbox.clear()
    this.resetCrypto()
    this.socket?.close()
    this.socket = null
  }

  private scheduleReconnect(message = 'Connection lost. Reconnecting…'): void {
    if (this.manuallyClosed || this.reconnectTimer !== undefined) return
    // Exponential backoff with a cap, reconnecting indefinitely: clipboard
    // rooms are short-lived and the user may just have walked through a
    // tunnel. device_in_use stops retries via stopRetrying(); leaving the room
    // stops them via close().
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** Math.min(this.reconnectAttempts, 4), MAX_RECONNECT_DELAY_MS)
    this.reconnectAttempts += 1
    this.emit({ type: 'status', status: 'error', message })
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.manuallyClosed) this.openSocket()
    }, delay)
  }

  private stopRetrying(): void {
    this.manuallyClosed = true
    this.clearResend()
    this.clearPing()
    this.clearReconnect()
    this.clearConnectTimer()
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) window.clearTimeout(this.connectTimer)
    this.connectTimer = undefined
  }

  private clearPing(): void {
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private emit(event: RoomClientEvent): void {
    this.listeners.forEach((listener) => listener(event))
  }
}

export function parseInvite(input: string): string | null {
  const text = input.trim()
  try {
    const url = new URL(text)
    const fromQuery = url.searchParams.get('join')?.trim().toUpperCase()
    if (fromQuery) return /^[A-Z0-9]{8}$/.test(fromQuery) ? fromQuery : null
    // Current invites carry the code in the fragment (#join=CODE).
    const fromHash = /(?:^|[#&])join=([A-Za-z0-9]{8})(?:$|&)/.exec(url.hash)
    return fromHash ? fromHash[1].toUpperCase() : null
  } catch {
    const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
    return /^[A-Z0-9]{8}$/.test(code) ? code : null
  }
}
