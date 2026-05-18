import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Each migration is applied in order, exactly once. Append-only — never edit a
// previous entry's SQL, even to fix a typo, or older databases will diverge.
// Bump the version, write a new migration that corrects the prior one.
interface Migration {
  version: number
  description: string
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'initial schema (connections, payments, invoices, processed_events)',
    sql: `
      CREATE TABLE connections (
        id                  INTEGER PRIMARY KEY,
        label               TEXT,
        service_secret_hex  TEXT    NOT NULL,
        service_pubkey_hex  TEXT    NOT NULL UNIQUE,
        client_pubkey_hex   TEXT    NOT NULL,
        budget_msat         INTEGER,
        spent_msat          INTEGER NOT NULL DEFAULT 0,
        expires_at          INTEGER,
        created_at          INTEGER NOT NULL,
        revoked_at          INTEGER
      );
      CREATE INDEX idx_connections_client_pubkey ON connections(client_pubkey_hex);

      CREATE TABLE payments (
        id                  INTEGER PRIMARY KEY,
        connection_id       INTEGER NOT NULL REFERENCES connections(id),
        request_event_id    TEXT    NOT NULL UNIQUE,
        invoice             TEXT    NOT NULL,
        payment_hash        TEXT    NOT NULL,
        amount_msat         INTEGER NOT NULL,
        fees_paid_msat      INTEGER,
        swap_id             TEXT,
        state               TEXT    NOT NULL,
        preimage            TEXT,
        error               TEXT,
        created_at          INTEGER NOT NULL,
        settled_at          INTEGER
      );
      CREATE INDEX idx_payments_connection ON payments(connection_id);
      CREATE INDEX idx_payments_payment_hash ON payments(payment_hash);
      CREATE INDEX idx_payments_state ON payments(state);

      CREATE TABLE invoices (
        id                  INTEGER PRIMARY KEY,
        connection_id       INTEGER NOT NULL REFERENCES connections(id),
        request_event_id    TEXT    NOT NULL UNIQUE,
        invoice             TEXT    NOT NULL,
        payment_hash        TEXT    NOT NULL,
        amount_msat         INTEGER NOT NULL,
        description         TEXT,
        swap_id             TEXT,
        state               TEXT    NOT NULL,
        preimage            TEXT,
        claimed_txid        TEXT,
        created_at          INTEGER NOT NULL,
        expires_at          INTEGER,
        settled_at          INTEGER
      );
      CREATE INDEX idx_invoices_connection ON invoices(connection_id);
      CREATE INDEX idx_invoices_payment_hash ON invoices(payment_hash);
      CREATE INDEX idx_invoices_state ON invoices(state);

      CREATE TABLE processed_events (
        event_id            TEXT    PRIMARY KEY,
        connection_id       INTEGER REFERENCES connections(id),
        method              TEXT,
        processed_at        INTEGER NOT NULL
      );
    `,
  },
]

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  INTEGER NOT NULL
    )
  `)

  applyMigrations(db)
  return db
}

function applyMigrations(db: Database): void {
  const appliedQuery = db.query<{ version: number }, []>(
    'SELECT version FROM schema_migrations ORDER BY version',
  )
  const applied = new Set(appliedQuery.all().map((r) => r.version))

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue

    db.transaction(() => {
      db.exec(m.sql)
      db.query(
        'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
      ).run(m.version, m.description, Math.floor(Date.now() / 1000))
    })()

    console.log(`db: applied migration v${m.version} — ${m.description}`)
  }
}
