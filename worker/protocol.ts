// Canonical room protocol. src/types.ts mirrors these shapes for the client;
// src/types.test.ts asserts the limits stay aligned. Change both together.
export type DeviceKind = 'desktop' | 'phone'

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

const MAX_TEXT_LENGTH = 100_000
// A P-256 uncompressed point is 65 bytes (~88 chars base64url); 256 leaves
// generous headroom while bounding what the relay will forward.
export const MAX_PUBKEY_LENGTH = 256
export const MAX_CONFIRM_LENGTH = 128
// Sized so the largest legal client item — 100k characters of text plus a
// 350 KB image — still fits after AES-GCM + base64 (~760 KB worst case),
// while staying under the ~1 MiB per-frame WebSocket limit.
const MAX_SEALED_LENGTH = 900_000
// Per-session secret a client presents in hello so it can replace its own
// still-live socket on reconnect; anyone else needs the old socket to go stale.
export const MAX_RESUME_LENGTH = 64
// A sealed clear-history control (id + timestamp) is well under 200 chars.
export const MAX_SEALED_CONTROL_LENGTH = 512
export const MAX_ID_LENGTH = 80
// Greatest date representable as a JS timestamp (8.64e15). createdAt must be a
// finite integer in (0, MAX_TIMESTAMP] so relays never forward NaN/Infinity,
// negative sort poison, or far-future timestamps that pin history ordering.
export const MAX_TIMESTAMP = 8_640_000_000_000_000

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0 && value <= MAX_TIMESTAMP
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (
    message.type === 'hello' &&
    message.version === 1 &&
    (message.device === 'desktop' || message.device === 'phone') &&
    (message.resume === undefined ||
      (typeof message.resume === 'string' && message.resume.length > 0 && message.resume.length <= MAX_RESUME_LENGTH))
  ) {
    return message as ClientMessage
  }
  if (
    message.type === 'clipboard-item' &&
    isValidId(message.id) &&
    typeof message.sealed === 'string' &&
    message.sealed.length > 0 &&
    message.sealed.length <= MAX_SEALED_LENGTH &&
    isValidTimestamp(message.createdAt)
  ) {
    return message as ClientMessage
  }
  if (
    message.type === 'key-exchange' &&
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
  ) {
    return message as ClientMessage
  }
  if (message.type === 'ping' && isValidTimestamp(message.timestamp)) return message as ClientMessage
  if (message.type === 'ack' && isValidId(message.id)) return message as ClientMessage
  if (
    message.type === 'clear-history' &&
    typeof message.sealed === 'string' &&
    message.sealed.length > 0 &&
    message.sealed.length <= MAX_SEALED_CONTROL_LENGTH
  ) {
    return message as ClientMessage
  }
  return null
}

export function encode(message: ServerMessage): string {
  return JSON.stringify(message)
}

export { MAX_TEXT_LENGTH, MAX_SEALED_LENGTH }
