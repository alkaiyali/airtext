// Ephemeral ECDH (P-256) + HKDF-SHA256 + AES-GCM.
//
// Each connection generates a fresh keypair; the room code is only the
// rendezvous name and HKDF context — never the encryption key. A passive
// observer (or log reader) learns nothing, old sessions stay sealed after
// both sides leave (forward secrecy), and the 48-bit match code lets the two
// humans detect an active relay MITM by comparing screens.

const IV_BYTES = 12
// 48-bit match code: offline collision search costs ~2^24 ECDH operations,
// and every attempt needs a live join both peers can see.
const VERIFY_BYTES = 6

export interface SessionKeys {
  messageKey: CryptoKey
  confirmKey: CryptoKey
  /** 12 hex chars grouped as "a3f9 22c1 9b04" — identical on both sides. */
  verifyCode: string
}

function enc(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid key encoding.')
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
}

/** Export the public half as base64url of the 65-byte uncompressed point. */
export async function exportPublicKey(pair: CryptoKeyPair): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  return bytesToBase64Url(raw)
}

/** Import a peer's public key; throws on malformed points or off-curve keys. */
export async function importPeerKey(publicKey: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(publicKey)
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('Invalid public key.')
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(raw.slice(1, 33)),
    y: bytesToBase64Url(raw.slice(33, 65)),
    ext: true,
  }
  return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

/**
 * Derive the session from our keypair and the peer's public key. Deterministic:
 * both sides compute identical keys regardless of who sent first. The room
 * code binds the keys to this room (domain separation), not secrecy.
 */
export async function deriveSession(
  ownPair: CryptoKeyPair,
  peerPublicKey: string,
  roomCode: string,
): Promise<SessionKeys> {
  const peerKey = await importPeerKey(peerPublicKey)
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, ownPair.privateKey, 256)
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey', 'deriveBits'])
  const salt = enc(`airtext-e2e-v1:${roomCode}`)
  const messageKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc('airtext-msg-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const confirmKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc('airtext-confirm-v1') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
  const verifyBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc('airtext-verify-v1') }, base, VERIFY_BYTES * 8),
  )
  const hex = Array.from(verifyBits, (b) => b.toString(16).padStart(2, '0')).join('')
  const verifyCode = `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)}`
  return { messageKey, confirmKey, verifyCode }
}

/** Prove knowledge of the shared secret, bound to our public key. */
export async function makeConfirm(confirmKey: CryptoKey, ownPublicKey: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', confirmKey, enc(`airtext-confirm:${ownPublicKey}`))
  return bytesToBase64Url(mac)
}

/** Check the peer's proof; false means mismatched keys — fail closed. */
export async function verifyConfirm(confirmKey: CryptoKey, peerPublicKey: string, confirm: string): Promise<boolean> {
  try {
    const mac = base64UrlToBytes(confirm)
    return await crypto.subtle.verify('HMAC', confirmKey, mac, enc(`airtext-confirm:${peerPublicKey}`))
  } catch {
    return false
  }
}

// Encode/Decode binary data as base64 for transport, and wrap a ciphertext+iv pair.
function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i])
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function ivToBase64(iv: Uint8Array): string {
  return bytesToBase64(iv.slice().buffer as ArrayBuffer)
}

export async function seal(messageKey: CryptoKey, plaintext: string): Promise<string> {
  const iv = new Uint8Array(crypto.getRandomValues(new Uint8Array(IV_BYTES)))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, messageKey, new TextEncoder().encode(plaintext))
  return `${ivToBase64(iv)}.${bytesToBase64(ciphertext)}`
}

export async function open(messageKey: CryptoKey, sealed: string): Promise<string | null> {
  if (typeof sealed !== 'string' || !sealed.includes('.')) return null
  const dot = sealed.indexOf('.')
  if (dot <= 0 || dot >= sealed.length - 1) return null
  try {
    const iv = base64ToBytes(sealed.slice(0, dot))
    const ciphertext = base64ToBytes(sealed.slice(dot + 1))
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, messageKey, ciphertext.buffer)
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}
