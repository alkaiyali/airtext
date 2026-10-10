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
    typeof message.id === 'string' &&
    message.id.length <= 80 &&
    typeof message.sealed === 'string' &&
    message.sealed.length > 0 &&
    message.sealed.length <= MAX_SEALED_LENGTH &&
    typeof message.createdAt === 'number'
  ) {
    return message as ClientMessage
  }
  if (
    message.type === 'key-exchange' &&
    typeof message.id === 'string' &&
    message.id.length <= 80 &&
    typeof message.publicKey === 'string' &&
    message.publicKey.length > 0 &&
    message.publicKey.length <= MAX_PUBKEY_LENGTH &&
    (message.confirm === undefined ||
      (typeof message.confirm === 'string' && message.confirm.length <= MAX_CONFIRM_LENGTH)) &&
    typeof message.createdAt === 'number'
  ) {
    return message as ClientMessage
  }
  if (message.type === 'ping' && typeof message.timestamp === 'number') return message as ClientMessage
  if (message.type === 'ack' && typeof message.id === 'string' && message.id.length <= 80) return message as ClientMessage
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
