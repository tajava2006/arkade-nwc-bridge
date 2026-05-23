import { describe, expect, test } from 'bun:test'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { decryptContent, encryptContent, pickRequestScheme } from '../../src/nostr/crypto'
import { NwcError } from '../../src/lib/errors'

function makePair() {
  // Client + service end of an NWC connection. Either side can encrypt to
  // the other; we exercise both directions because NIP-47 requests go
  // client → service and responses go service → client.
  const clientSec = generateSecretKey()
  const serviceSec = generateSecretKey()
  return {
    clientSec,
    clientPub: getPublicKey(clientSec),
    serviceSec,
    servicePub: getPublicKey(serviceSec),
  }
}

describe('crypto', () => {
  test('nip44_v2 round-trip (client → service → client)', () => {
    const p = makePair()
    const plaintext = JSON.stringify({ method: 'get_balance', params: {} })

    const ciphertext = encryptContent('nip44_v2', p.clientSec, p.servicePub, plaintext)
    const decrypted = decryptContent('nip44_v2', p.serviceSec, p.clientPub, ciphertext)
    expect(decrypted).toBe(plaintext)
  })

  test('nip04 round-trip (legacy default)', () => {
    const p = makePair()
    const plaintext = 'hello, nostr'
    const ciphertext = encryptContent('nip04', p.clientSec, p.servicePub, plaintext)
    expect(ciphertext).toContain('?iv=')
    const decrypted = decryptContent('nip04', p.serviceSec, p.clientPub, ciphertext)
    expect(decrypted).toBe(plaintext)
  })

  test('nip44_v2 ciphertexts differ from nip04 (no scheme mixing)', () => {
    const p = makePair()
    const c44 = encryptContent('nip44_v2', p.clientSec, p.servicePub, 'x')
    const c04 = encryptContent('nip04', p.clientSec, p.servicePub, 'x')
    expect(c44).not.toBe(c04)
    // nip04 emits the iv suffix; nip44 doesn't.
    expect(c04.includes('?iv=')).toBe(true)
    expect(c44.includes('?iv=')).toBe(false)
  })

  test('pickRequestScheme defaults to nip04 when no encryption tag', () => {
    expect(pickRequestScheme([])).toBe('nip04')
    expect(pickRequestScheme([['p', 'ff']])).toBe('nip04')
  })

  test('pickRequestScheme honors explicit nip44_v2 / nip04 tags', () => {
    expect(pickRequestScheme([['encryption', 'nip44_v2']])).toBe('nip44_v2')
    expect(pickRequestScheme([['encryption', 'nip04']])).toBe('nip04')
  })

  test('pickRequestScheme throws UNSUPPORTED_ENCRYPTION on unknown values', () => {
    try {
      pickRequestScheme([['encryption', 'nip44_v1']])
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(NwcError)
      expect((err as NwcError).code).toBe('UNSUPPORTED_ENCRYPTION')
    }
  })
})
