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

export type ClientMessage =
  | { type: 'hello'; version: 1; device: DeviceKind }
  | { type: 'clipboard-item'; id: string; sealed: string; createdAt: number }
  | { type: 'key-exchange'; id: string; publicKey: string; confirm?: string; createdAt: number }
  | { type: 'ack'; id: string }
  | { type: 'clear-history' }
  | { type: 'ping'; timestamp: number }

export type ServerMessage =
  | { type: 'hello'; version: 1; peers: number }
  | { type: 'peer-joined'; peers: number }
  | { type: 'peer-left'; peers: number }
  | { type: 'clipboard-item'; id: string; sealed: string; createdAt: number; source: DeviceKind }
  | { type: 'key-exchange'; id: string; publicKey: string; confirm?: string; createdAt: number; source: DeviceKind }
  | { type: 'ack'; id: string }
  | { type: 'clear-history' }
  | { type: 'pong'; timestamp: number }
  | { type: 'error'; code: string; message: string }

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (typeof message.type !== 'string') return false

  if (message.type === 'hello') {
    return message.version === 1 && typeof message.peers === 'number'
  }
  if (message.type === 'peer-joined' || message.type === 'peer-left') {
    return typeof message.peers === 'number'
  }
  if (message.type === 'ack') return typeof message.id === 'string'
  if (message.type === 'clear-history') return true
  if (message.type === 'clipboard-item') {
    return typeof message.id === 'string' && typeof message.sealed === 'string' && typeof message.createdAt === 'number' && (message.source === 'desktop' || message.source === 'phone')
  }
  if (message.type === 'key-exchange') {
    return (
      typeof message.id === 'string' &&
      typeof message.publicKey === 'string' &&
      (message.confirm === undefined || typeof message.confirm === 'string') &&
      typeof message.createdAt === 'number' &&
      (message.source === 'desktop' || message.source === 'phone')
    )
  }
  if (message.type === 'pong') return typeof message.timestamp === 'number'
  if (message.type === 'error') return typeof message.code === 'string' && typeof message.message === 'string'
  return false
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (message.type === 'hello') return message.version === 1 && (message.device === 'desktop' || message.device === 'phone')
  if (message.type === 'clipboard-item') {
    return typeof message.id === 'string' && typeof message.sealed === 'string' && typeof message.createdAt === 'number'
  }
  if (message.type === 'key-exchange') {
    return (
      typeof message.id === 'string' &&
      typeof message.publicKey === 'string' &&
      (message.confirm === undefined || typeof message.confirm === 'string') &&
      typeof message.createdAt === 'number'
    )
  }
  if (message.type === 'ack') return typeof message.id === 'string'
  if (message.type === 'clear-history') return true
  if (message.type === 'ping') return typeof message.timestamp === 'number'
  return false
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

export const MAX_TEXT_LENGTH = 100_000
export const MAX_IMAGE_BYTES = 350_000
// Mirrors worker/protocol.ts: sealed payloads above this never fit a frame.
export const MAX_SEALED_LENGTH = 900_000
// Mirror worker/protocol.ts key-exchange bounds (asserted in types.test.ts).
export const MAX_PUBKEY_LENGTH = 256
export const MAX_CONFIRM_LENGTH = 128

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
