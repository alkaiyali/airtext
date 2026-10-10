import { describe, expect, it } from 'vitest'
import {
  deriveSession,
  exportPublicKey,
  generateKeyPair,
  makeConfirm,
  open,
  seal,
  verifyConfirm,
} from './crypto'

async function handshake(roomCode: string) {
  const a = await generateKeyPair()
  const b = await generateKeyPair()
  const aPub = await exportPublicKey(a)
  const bPub = await exportPublicKey(b)
  const sessionA = await deriveSession(a, bPub, roomCode)
  const sessionB = await deriveSession(b, aPub, roomCode)
  return { a, b, aPub, bPub, sessionA, sessionB }
}

describe('ECDH session', () => {
  it('derives identical keys and match codes on both sides', async () => {
    const { sessionA, sessionB } = await handshake('AB12CD34')
    expect(sessionA.verifyCode).toBe(sessionB.verifyCode)
    expect(sessionA.verifyCode).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/)
    const sealed = await seal(sessionA.messageKey, JSON.stringify({ text: 'secret note' }))
    expect(await open(sessionB.messageKey, sealed)).toBe('{"text":"secret note"}')
  })

  it('binds keys to the room: different rooms derive different match codes', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const bPub = await exportPublicKey(b)
    const room1 = await deriveSession(a, bPub, 'ROOM0001')
    const room2 = await deriveSession(a, bPub, 'ROOM0002')
    expect(room1.verifyCode).not.toBe(room2.verifyCode)
    const sealed = await seal(room1.messageKey, 'x')
    expect(await open(room2.messageKey, sealed)).toBeNull()
  })

  it('confirms key agreement and rejects tampered proofs', async () => {
    const { aPub, bPub, sessionA, sessionB } = await handshake('AB12CD34')
    const confirmA = await makeConfirm(sessionA.confirmKey, aPub)
    const confirmB = await makeConfirm(sessionB.confirmKey, bPub)
    expect(await verifyConfirm(sessionB.confirmKey, aPub, confirmA)).toBe(true)
    expect(await verifyConfirm(sessionA.confirmKey, bPub, confirmB)).toBe(true)
    expect(await verifyConfirm(sessionB.confirmKey, aPub, confirmB)).toBe(false)
    expect(await verifyConfirm(sessionB.confirmKey, aPub, 'not-valid!!!')).toBe(false)
  })

  it('gives a MITM separate sessions with (overwhelmingly likely) different codes', async () => {
    // Attacker M sits between A and B with a keypair per leg.
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const m1 = await generateKeyPair()
    const m2 = await generateKeyPair()
    const [m1Pub, m2Pub] = await Promise.all([m1, m2].map(exportPublicKey))
    const sessionAM = await deriveSession(a, m1Pub, 'AB12CD34')
    const sessionBM = await deriveSession(b, m2Pub, 'AB12CD34')
    expect(sessionAM.verifyCode).not.toBe(sessionBM.verifyCode)
    // And the attacker cannot read A's messages to B's session.
    const sealed = await seal(sessionAM.messageKey, 'secret')
    expect(await open(sessionBM.messageKey, sealed)).toBeNull()
  })

  it('rejects malformed peer keys', async () => {
    const a = await generateKeyPair()
    await expect(deriveSession(a, '!!!', 'AB12CD34')).rejects.toThrow()
    await expect(deriveSession(a, 'AAAA', 'AB12CD34')).rejects.toThrow()
  })
})
