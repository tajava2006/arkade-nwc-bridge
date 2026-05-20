import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'
import { NwcError } from '../lib/errors'

export type EncryptionScheme = 'nip44_v2' | 'nip04'

/**
 * Picks the encryption scheme to use for a response based on the `encryption`
 * tag the client sent on the request. NIP-47 says absence of the tag means
 * nip04 (legacy default).
 */
export function pickRequestScheme(tags: string[][]): EncryptionScheme {
  const tag = tags.find((t) => t[0] === 'encryption')
  if (!tag) return 'nip04'
  const requested = tag[1]
  if (requested === 'nip44_v2') return 'nip44_v2'
  if (requested === 'nip04') return 'nip04'
  throw new NwcError('UNSUPPORTED_ENCRYPTION', `encryption '${requested ?? ''}' not supported`)
}

export function decryptContent(
  scheme: EncryptionScheme,
  ourSecret: Uint8Array,
  theirPubkey: string,
  ciphertext: string,
): string {
  if (scheme === 'nip44_v2') {
    const key = nip44.getConversationKey(ourSecret, theirPubkey)
    return nip44.decrypt(ciphertext, key)
  }
  return nip04.decrypt(ourSecret, theirPubkey, ciphertext)
}

export function encryptContent(
  scheme: EncryptionScheme,
  ourSecret: Uint8Array,
  theirPubkey: string,
  plaintext: string,
): string {
  if (scheme === 'nip44_v2') {
    const key = nip44.getConversationKey(ourSecret, theirPubkey)
    return nip44.encrypt(plaintext, key)
  }
  return nip04.encrypt(ourSecret, theirPubkey, plaintext)
}
