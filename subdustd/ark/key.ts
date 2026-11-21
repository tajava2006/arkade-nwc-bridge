import { closeSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'

// subdustd's own Ark key (D4): one 32-byte secret, hex, in its own file. It
// funds receives and collects send proceeds, so losing it loses that float.
// Never generated on boot — a wrong volume mount would otherwise mint a fresh
// empty wallet and the funds on the real key would silently drop out of view.

export class KeyFileError extends Error {}

export const generateKeyFile = (path: string): Uint8Array => {
  const key = secp256k1.utils.randomSecretKey()
  // 'wx' = create only: never overwrite an existing key, whatever is in it.
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (e) {
    throw new KeyFileError(`${path}: ${(e as NodeJS.ErrnoException).code === 'EEXIST' ? 'already exists — refusing to overwrite a key' : (e as Error).message}`)
  }
  try {
    writeSync(fd, `${hex.encode(key)}\n`)
  } finally {
    closeSync(fd)
  }
  return key
}

export const loadKeyFile = (path: string): { key: Uint8Array; warnings: string[] } => {
  let text: string
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch (e) {
    throw new KeyFileError(`${path}: ${(e as Error).message}`)
  }
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new KeyFileError(`${path}: expected 64 hex characters`)
  const key = hex.decode(text.toLowerCase())
  if (!secp256k1.utils.isValidSecretKey(key)) throw new KeyFileError(`${path}: not a valid secp256k1 secret key`)
  const warnings: string[] = []
  if ((statSync(path).mode & 0o077) !== 0) warnings.push(`${path} is readable by group/other — chmod 600`)
  return { key, warnings }
}
