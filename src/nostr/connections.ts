import type { Database } from 'bun:sqlite'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'

export interface Connection {
  id: number
  label: string | null
  serviceSecretHex: string
  servicePubkeyHex: string
  clientPubkeyHex: string
  budgetMsat: number | null
  spentMsat: number
  expiresAt: number | null
  createdAt: number
  revokedAt: number | null
}

interface ConnectionRow {
  id: number
  label: string | null
  service_secret_hex: string
  service_pubkey_hex: string
  client_pubkey_hex: string
  budget_msat: number | null
  spent_msat: number
  expires_at: number | null
  created_at: number
  revoked_at: number | null
}

function rowToConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    label: row.label,
    serviceSecretHex: row.service_secret_hex,
    servicePubkeyHex: row.service_pubkey_hex,
    clientPubkeyHex: row.client_pubkey_hex,
    budgetMsat: row.budget_msat,
    spentMsat: row.spent_msat,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

export interface NewConnectionResult {
  connection: Connection
  /**
   * The client's secret key. NIP-47 says the wallet service SHOULD NOT
   * persist this — it is shown to the user once (embedded in the URI) and
   * then discarded.
   */
  clientSecretHex: string
  uri: string
}

export function createConnection(
  db: Database,
  args: { label: string | null; relays: string[] },
): NewConnectionResult {
  if (args.relays.length === 0) {
    throw new Error('at least one relay url is required')
  }

  const serviceSecret = generateSecretKey()
  const servicePubkey = getPublicKey(serviceSecret)
  const clientSecret = generateSecretKey()
  const clientPubkey = getPublicKey(clientSecret)
  const createdAt = Math.floor(Date.now() / 1000)

  const row = db
    .query<ConnectionRow, [string | null, string, string, string, number]>(
      `INSERT INTO connections (
         label, service_secret_hex, service_pubkey_hex, client_pubkey_hex, created_at
       ) VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(args.label, bytesToHex(serviceSecret), servicePubkey, clientPubkey, createdAt)

  if (!row) {
    throw new Error('failed to insert connection row')
  }

  return {
    connection: rowToConnection(row),
    clientSecretHex: bytesToHex(clientSecret),
    uri: buildNwcUri({
      servicePubkeyHex: servicePubkey,
      clientSecretHex: bytesToHex(clientSecret),
      relays: args.relays,
    }),
  }
}

export function listActiveConnections(db: Database): Connection[] {
  return db
    .query<ConnectionRow, []>(
      'SELECT * FROM connections WHERE revoked_at IS NULL ORDER BY id',
    )
    .all()
    .map(rowToConnection)
}

export function findConnectionByServicePubkey(
  db: Database,
  servicePubkeyHex: string,
): Connection | null {
  const row = db
    .query<ConnectionRow, [string]>(
      'SELECT * FROM connections WHERE service_pubkey_hex = ? AND revoked_at IS NULL',
    )
    .get(servicePubkeyHex)
  return row ? rowToConnection(row) : null
}

export function markEventProcessed(
  db: Database,
  args: { eventId: string; connectionId: number; method: string },
): void {
  db.query(
    `INSERT OR IGNORE INTO processed_events (event_id, connection_id, method, processed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(args.eventId, args.connectionId, args.method, Math.floor(Date.now() / 1000))
}

export function isEventProcessed(db: Database, eventId: string): boolean {
  const row = db
    .query<{ event_id: string }, [string]>('SELECT event_id FROM processed_events WHERE event_id = ?')
    .get(eventId)
  return row !== null
}

export function serviceSecretBytes(conn: Connection): Uint8Array {
  return hexToBytes(conn.serviceSecretHex)
}

function buildNwcUri(args: {
  servicePubkeyHex: string
  clientSecretHex: string
  relays: string[]
}): string {
  const params = new URLSearchParams()
  for (const r of args.relays) params.append('relay', r)
  params.append('secret', args.clientSecretHex)
  return `nostr+walletconnect://${args.servicePubkeyHex}?${params.toString()}`
}
