export type DeviceKind = 'desktop' | 'phone'
export type EntrySource = 'this device' | 'other device'

export interface ClipboardEntry {
  id: string
  text: string
  createdAt: number
  source: EntrySource
  image?: string
  kind?: 'text' | 'image'
  roomId?: string
}

export type RoomStatus = 'idle' | 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'error'

export const MAX_TEXT_LENGTH = 100_000
export const MAX_IMAGE_BYTES = 350_000
// Mirrors worker/protocol.ts: sealed payloads above this never fit a frame.
export const MAX_SEALED_LENGTH = 900_000
// Mirror worker/protocol.ts key-exchange bounds (asserted in types.test.ts).
export const MAX_PUBKEY_LENGTH = 256
export const MAX_CONFIRM_LENGTH = 128
export const MAX_ID_LENGTH = 80
export const MAX_SEALED_CONTROL_LENGTH = 512
export const MAX_RESUME_LENGTH = 64
// Greatest date representable as a JS timestamp (8.64e15). Mirrors the Worker:
// relays must never forward NaN/Infinity or out-of-range dates.
export const MAX_TIMESTAMP = 8_640_000_000_000_000

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

function isPeerCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 8
}

function isBoundedSealed(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_TIMESTAMP
  )
}

export type ClientMessage =
  | { type: 'hello'; version: 1; device: DeviceKind; resume?: string }
  | { type: 'clipboard-item'; id: string; sealed: string; createdAt: number }
  | { type: 'key-exchange'; id: string; publicKey: string; confirm?: string; createdAt: number }
  | { type: 'ack'; id: string }
  | { type: 'clear-history'; sealed: string }
  | { type: 'ping'; timestamp: number }

export type ServerMessage =
  | { type: 'hello'; version: 1; peers: number }
  | { type: 'peer-joined'; peers: number }
  | { type: 'peer-left'; peers: number }
  | { type: 'clipboard-item'; id: string; sealed: string; createdAt: number; source: DeviceKind }
  | { type: 'key-exchange'; id: string; publicKey: string; confirm?: string; createdAt: number; source: DeviceKind }
  | { type: 'ack'; id: string }
  | { type: 'clear-history'; sealed: string }
  | { type: 'pong'; timestamp: number }
  | { type: 'error'; code: string; message: string }

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (typeof message.type !== 'string') return false

  if (message.type === 'hello') {
    return message.version === 1 && isPeerCount(message.peers)
  }
  if (message.type === 'peer-joined' || message.type === 'peer-left') {
    return isPeerCount(message.peers)
  }
  if (message.type === 'ack') return isValidId(message.id)
  if (message.type === 'clear-history') {
    return isBoundedSealed(message.sealed, MAX_SEALED_CONTROL_LENGTH)
  }
  if (message.type === 'clipboard-item') {
    return (
      isValidId(message.id) &&
      isBoundedSealed(message.sealed, MAX_SEALED_LENGTH) &&
      isValidTimestamp(message.createdAt) &&
      (message.source === 'desktop' || message.source === 'phone')
    )
  }
  if (message.type === 'key-exchange') {
    return (
      isValidId(message.id) &&
      typeof message.publicKey === 'string' &&
      message.publicKey.length > 0 &&
      message.publicKey.length <= MAX_PUBKEY_LENGTH &&
      BASE64URL_RE.test(message.publicKey) &&
      (message.confirm === undefined ||
        (typeof message.confirm === 'string' &&
          message.confirm.length > 0 &&
          message.confirm.length <= MAX_CONFIRM_LENGTH &&
          BASE64URL_RE.test(message.confirm))) &&
      isValidTimestamp(message.createdAt) &&
      (message.source === 'desktop' || message.source === 'phone')
    )
  }
  if (message.type === 'pong') return isValidTimestamp(message.timestamp)
  if (message.type === 'error') {
    return (
      typeof message.code === 'string' &&
      message.code.length > 0 &&
      message.code.length <= 64 &&
      typeof message.message === 'string' &&
      message.message.length <= 500
    )
  }
  return false
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (message.type === 'hello') {
    return (
      message.version === 1 &&
      (message.device === 'desktop' || message.device === 'phone') &&
      (message.resume === undefined ||
        (typeof message.resume === 'string' && message.resume.length > 0 && message.resume.length <= MAX_RESUME_LENGTH))
    )
  }
  if (message.type === 'clipboard-item') {
    return isValidId(message.id) && isBoundedSealed(message.sealed, MAX_SEALED_LENGTH) && isValidTimestamp(message.createdAt)
  }
  if (message.type === 'key-exchange') {
    return (
      isValidId(message.id) &&
      typeof message.publicKey === 'string' &&
      message.publicKey.length > 0 &&
      message.publicKey.length <= MAX_PUBKEY_LENGTH &&
      BASE64URL_RE.test(message.publicKey) &&
      (message.confirm === undefined ||
        (typeof message.confirm === 'string' &&
          message.confirm.length > 0 &&
          message.confirm.length <= MAX_CONFIRM_LENGTH &&
          BASE64URL_RE.test(message.confirm))) &&
      isValidTimestamp(message.createdAt)
    )
  }
  if (message.type === 'ack') return isValidId(message.id)
  if (message.type === 'clear-history') {
    return isBoundedSealed(message.sealed, MAX_SEALED_CONTROL_LENGTH)
  }
  if (message.type === 'ping') return isValidTimestamp(message.timestamp)
  return false
}

// Shared images are always produced by image.ts as base64 webp/jpeg. Anything
// else from the peer (remote URLs, SVG, other schemes) is dropped.
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:webp|jpeg|png|gif);base64,[A-Za-z0-9+/]+=*$/

export function isSafeImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SEALED_LENGTH && SAFE_IMAGE_DATA_URL.test(value)
}

export function getRoomIdFromCode(code: string): string | null {
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!/^[A-Z0-9]{8}$/.test(normalized)) return null
  return normalized
}

// Unambiguous alphabet: drops 0/O and 1/I/L lookalikes. Length 32 gives each
// character exactly 5 bits, so 8 characters carry 40 bits of entropy.
const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const ROOM_CODE_LENGTH = 8
// Bytes at or above the largest multiple of 32 would bias the sampling.
const ALPHABET_BYTE_LIMIT = Math.floor(256 / ROOM_CODE_ALPHABET.length) * ROOM_CODE_ALPHABET.length

export function createRoomCode(): string {
  let code = ''
  while (code.length < ROOM_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH * 2))
    for (const byte of bytes) {
      if (byte >= ALPHABET_BYTE_LIMIT) continue
      code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]
      if (code.length === ROOM_CODE_LENGTH) break
    }
  }
  return code
}

export function roomInviteUrl(code: string): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  // Query param, deliberately: URL fragments get stripped or mangled by
  // several phone scanner chains (native camera quick actions, in-app
  // browsers), which silently broke pairing. Room codes are short-lived
  // bearer tokens, so log exposure is bounded to the room's lifetime.
  url.searchParams.set('join', code)
  return url.toString()
}
