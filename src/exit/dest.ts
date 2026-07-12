import type { Database } from 'bun:sqlite'
import { getNetwork } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import type { Network } from '../defaults'
import { checkDestAddress, verifyDestSignature } from './dest_verify'

// exit_dest CRUD (migration v16) + the challenge lifecycle around
// dest_verify.ts. The challenge text embeds the address, so a signature
// can never be replayed to authorize a different destination; the nonce
// makes every issuance unique. No expiry: the whole point of the scheme
// is that signing may happen on an air-gapped machine on its own schedule,
// and a re-issued challenge voids the old one anyway (single row).

export interface ExitDest {
  address: string
  challenge: string
  issuedAt: number
  verifiedAt: number | null
  scheme: string | null
  sendTxid: string | null
  sentAt: number | null
}

interface Row {
  address: string
  challenge: string
  issued_at: number
  verified_at: number | null
  scheme: string | null
  send_txid: string | null
  sent_at: number | null
}

const rowToDest = (r: Row): ExitDest => ({
  address: r.address,
  challenge: r.challenge,
  issuedAt: r.issued_at,
  verifiedAt: r.verified_at,
  scheme: r.scheme,
  sendTxid: r.send_txid,
  sentAt: r.sent_at,
})

export function getExitDest(db: Database): ExitDest | null {
  const row = db.query<Row, []>('SELECT * FROM exit_dest WHERE id = 1').get()
  return row ? rowToDest(row) : null
}

export type IssueResult = { ok: true; dest: ExitDest } | { ok: false; reason: string }

export function issueDestChallenge(db: Database, network: Network, address: string): IssueResult {
  const trimmed = address.trim()
  const check = checkDestAddress(trimmed, getNetwork(network))
  if (!check.ok) return { ok: false, reason: check.reason }

  const nonce = hex.encode(crypto.getRandomValues(new Uint8Array(8)))
  const challenge = `arkade-bridge final send: sweep ALL exit funds to ${trimmed} (nonce: ${nonce})`
  db.query(
    `INSERT INTO exit_dest (id, address, challenge, issued_at, verified_at, scheme, send_txid, sent_at)
     VALUES (1, ?, ?, ?, NULL, NULL, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       address = excluded.address, challenge = excluded.challenge,
       issued_at = excluded.issued_at, verified_at = NULL, scheme = NULL,
       send_txid = NULL, sent_at = NULL`,
  ).run(trimmed, challenge, Math.floor(Date.now() / 1000))
  return { ok: true, dest: getExitDest(db)! }
}

export type SubmitResult = { ok: true; dest: ExitDest } | { ok: false; reason: string }

export function submitDestSignature(
  db: Database,
  network: Network,
  signatureB64: string,
): SubmitResult {
  const dest = getExitDest(db)
  if (!dest) return { ok: false, reason: 'no challenge issued — enter an address first' }

  const result = verifyDestSignature(dest.address, dest.challenge, signatureB64, getNetwork(network))
  if (!result.valid) return { ok: false, reason: result.reason }

  db.query('UPDATE exit_dest SET verified_at = ?, scheme = ? WHERE id = 1').run(
    Math.floor(Date.now() / 1000),
    result.scheme,
  )
  return { ok: true, dest: getExitDest(db)! }
}

export function clearExitDest(db: Database): void {
  db.query('DELETE FROM exit_dest WHERE id = 1').run()
}

/** the latest broadcast final send — an RBF boost overwrites, that IS the send now */
export function markDestSent(db: Database, txid: string): void {
  db.query('UPDATE exit_dest SET send_txid = ?, sent_at = ? WHERE id = 1').run(
    txid,
    Math.floor(Date.now() / 1000),
  )
}
