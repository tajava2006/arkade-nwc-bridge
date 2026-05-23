import type { Database } from 'bun:sqlite'
import { generateSecretKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'

export interface Account {
  id: number
  privateKey: Uint8Array
  nsec: string
  createdAt: number
}

interface AccountRow {
  id: number
  nsec_hex: string
  created_at: number
}

function rowToAccount(row: AccountRow): Account {
  const privateKey = hexToBytes(row.nsec_hex)
  return {
    id: row.id,
    privateKey,
    nsec: nip19.nsecEncode(privateKey),
    createdAt: row.created_at,
  }
}

export function loadAccount(db: Database): Account | null {
  const row = db
    .query<AccountRow, []>('SELECT * FROM accounts ORDER BY id LIMIT 1')
    .get()
  return row ? rowToAccount(row) : null
}

export function createAccount(db: Database, privateKey: Uint8Array): Account {
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`)
  }
  const row = db
    .query<AccountRow, [string, number]>(
      `INSERT INTO accounts (nsec_hex, created_at) VALUES (?, ?) RETURNING *`,
    )
    .get(bytesToHex(privateKey), Math.floor(Date.now() / 1000))
  if (!row) throw new Error('failed to insert account row')
  return rowToAccount(row)
}

export function generatePrivateKey(): Uint8Array {
  return generateSecretKey()
}

/**
 * Accept either a bech32 `nsec1...` string or a 64-char hex secret. Returns
 * the 32-byte private key. Throws on bad encoding so the /setup form can
 * surface a clear validation error instead of inserting garbage.
 */
export function parseNsecInput(input: string): Uint8Array {
  const s = input.trim()
  if (s.startsWith('nsec')) {
    const decoded = nip19.decode(s)
    if (decoded.type !== 'nsec') {
      throw new Error(`expected nsec, got ${decoded.type}`)
    }
    return decoded.data
  }
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return hexToBytes(s.toLowerCase())
  }
  throw new Error('not a valid nsec or 64-char hex secret')
}
