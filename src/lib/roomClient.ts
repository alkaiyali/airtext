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

const BASE_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 15_000
const KEEPALIVE_MS = 15_000

export type SocketFactory = (url: string) => WebSocket

export class RoomClient {
  private socket: WebSocket | null = null
  private readonly listeners = new Set<(event: RoomClientEvent) => void>()
  private pingTimer: number | undefined
  private reconnectTimer: number | undefined
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

  constructor(
    private readonly code: string,
    private readonly device: DeviceKind,
    private readonly createSocket: SocketFactory = (url) => new WebSocket(url),
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

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return
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
      this.emit({ type: 'status', status: 'error', message: 'Could not reach this room.' })
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
    this.send({ type: 'hello', version: 1, device: this.device })
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
  }

  private markUnsecure(): void {
    if (!this.secure) return
    this.secure = false
    this.emit({ type: 'unsecure' })
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
        this.emit({ type: 'status', status: 'error', message: 'The room sent an invalid message.' })
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
        this.emit({ type: 'status', status: 'error', message: message.message })
        // A definitive rejection (another live socket owns this device) should
        // not be retried forever: the server keeps a cooldown anyway, and a
        // loser that keeps reconnecting would keep re-replacing the winner.
        if (message.code === 'device_in_use') this.stopRetrying()
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

  async sendClipboardItem(id: string, createdAt: number, payload: { text: string; image?: string; kind?: 'text' | 'image' }): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected. The room is reconnecting — try again in a moment.')
    }
    if (!this.secure || !this.session) {
      throw new Error('Setting up the secure channel — try again in a moment.')
    }
    const sealedPayload = await seal(this.session.messageKey, JSON.stringify({ ...payload, id, createdAt }))
    if (sealedPayload.length > MAX_SEALED_LENGTH) {
      throw new Error('This item is too large to share in one piece.')
    }
    this.send({ type: 'clipboard-item', id, sealed: sealedPayload, createdAt })
  }

  close(): void {
    this.manuallyClosed = true
    this.clearPing()
    this.clearReconnect()
    this.resetCrypto()
    this.socket?.close()
    this.socket = null
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer !== undefined) return
    // Exponential backoff with a cap, reconnecting indefinitely: clipboard
    // rooms are short-lived and the user may just have walked through a
    // tunnel. device_in_use stops retries via stopRetrying(); leaving the room
    // stops them via close().
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** Math.min(this.reconnectAttempts, 4), MAX_RECONNECT_DELAY_MS)
    this.reconnectAttempts += 1
    this.emit({ type: 'status', status: 'error', message: 'Connection lost. Reconnecting…' })
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.manuallyClosed) this.openSocket()
    }, delay)
  }

  private stopRetrying(): void {
    this.manuallyClosed = true
    this.clearPing()
    this.clearReconnect()
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
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
