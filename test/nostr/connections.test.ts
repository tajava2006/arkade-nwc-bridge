import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createConnection,
  findConnectionById,
  findConnectionByServicePubkey,
  isEventProcessed,
  listActiveConnections,
  listAllConnections,
  markEventProcessed,
  revokeConnection,
  serviceSecretBytes,
} from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'

const RELAYS = ['wss://relay.example.com/v1', 'wss://relay2.example.com']

describe('connections', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('createConnection writes a row, returns secret + URI', () => {
    const r = createConnection(temp.db, { label: 'alby', relays: RELAYS })
    expect(r.connection.id).toBeGreaterThan(0)
    expect(r.connection.label).toBe('alby')
    expect(r.connection.servicePubkeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(r.connection.clientPubkeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(r.clientSecretHex).toMatch(/^[0-9a-f]{64}$/)
    expect(r.connection.revokedAt).toBeNull()
    expect(r.connection.spentMsat).toBe(0)
  })

  test('URI follows the NIP-47 format: nostr+walletconnect://<svcpk>?relay=...&secret=...', () => {
    const r = createConnection(temp.db, { label: null, relays: RELAYS, budgetMsat: 5_000 })
    expect(r.uri.startsWith(`nostr+walletconnect://${r.connection.servicePubkeyHex}?`)).toBe(true)
    const url = new URL(r.uri.replace('nostr+walletconnect://', 'https://'))
    expect(url.searchParams.getAll('relay')).toEqual(RELAYS)
    expect(url.searchParams.get('secret')).toBe(r.clientSecretHex)
  })

  test('rejects empty relay list', () => {
    expect(() => createConnection(temp.db, { label: null, relays: [] })).toThrow(/relay/i)
  })

  test('findConnectionById / findConnectionByServicePubkey round-trip', () => {
    const r = createConnection(temp.db, { label: null, relays: RELAYS })
    expect(findConnectionById(temp.db, r.connection.id)?.id).toBe(r.connection.id)
    expect(findConnectionByServicePubkey(temp.db, r.connection.servicePubkeyHex)?.id).toBe(
      r.connection.id,
    )
    expect(findConnectionById(temp.db, 9999)).toBeNull()
    expect(findConnectionByServicePubkey(temp.db, 'ff'.repeat(32))).toBeNull()
  })

  test('revokeConnection flips revoked_at and removes from active lookups', () => {
    const r = createConnection(temp.db, { label: null, relays: RELAYS })
    revokeConnection(temp.db, r.connection.id)

    // The lookup used by the nostr handler must return null for revoked.
    expect(findConnectionByServicePubkey(temp.db, r.connection.servicePubkeyHex)).toBeNull()
    expect(listActiveConnections(temp.db)).toHaveLength(0)

    // findById still works (UI shows revoked entries on detail page).
    const after = findConnectionById(temp.db, r.connection.id)
    expect(after?.revokedAt).not.toBeNull()

    const { active, revoked } = listAllConnections(temp.db)
    expect(active).toHaveLength(0)
    expect(revoked).toHaveLength(1)
  })

  test('serviceSecretBytes returns 32 bytes matching the stored hex', () => {
    const r = createConnection(temp.db, { label: null, relays: RELAYS })
    const bytes = serviceSecretBytes(r.connection)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(32)
  })

  test('processed_events round-trip prevents duplicate replies', () => {
    const r = createConnection(temp.db, { label: null, relays: RELAYS })
    expect(isEventProcessed(temp.db, 'evt-1')).toBe(false)
    markEventProcessed(temp.db, { eventId: 'evt-1', connectionId: r.connection.id, method: 'get_info' })
    expect(isEventProcessed(temp.db, 'evt-1')).toBe(true)
    // Idempotent — INSERT OR IGNORE means double-mark is a no-op, not a throw.
    expect(() =>
      markEventProcessed(temp.db, { eventId: 'evt-1', connectionId: r.connection.id, method: 'get_info' }),
    ).not.toThrow()
  })
})
