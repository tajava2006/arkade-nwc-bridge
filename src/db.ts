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
    description: 'initial schema (connections, transactions, processed_events)',
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

      -- Single transactions table covering both NWC-side incoming (reverse
      -- swaps) and outgoing (submarine swaps). type discriminates, the
      -- rest of the columns are a union of what each side needs:
      --   incoming uses description / expires_at
      --   outgoing uses error
      -- everything else is shared. This mirrors the NIP-47 transaction
      -- object shape (which is also one shape with a type field) and how
      -- most LN wallet UIs surface history — a single feed.
      CREATE TABLE transactions (
        id                  INTEGER PRIMARY KEY,
        connection_id       INTEGER NOT NULL REFERENCES connections(id),
        type                TEXT    NOT NULL,    -- 'incoming' | 'outgoing'
        request_event_id    TEXT    NOT NULL UNIQUE,
        invoice             TEXT    NOT NULL,
        payment_hash        TEXT    NOT NULL,
        amount_msat         INTEGER NOT NULL,    -- on-Ark wallet movement
        fees_paid_msat      INTEGER,
        description         TEXT,
        swap_id             TEXT,
        state               TEXT    NOT NULL,    -- 'pending' | 'settled' | 'failed' | 'expired'
        preimage            TEXT,
        error               TEXT,
        created_at          INTEGER NOT NULL,
        expires_at          INTEGER,
        settled_at          INTEGER
      );
      CREATE INDEX idx_transactions_connection ON transactions(connection_id);
      CREATE INDEX idx_transactions_payment_hash ON transactions(payment_hash);
      CREATE INDEX idx_transactions_state ON transactions(state);
      CREATE INDEX idx_transactions_type ON transactions(type);
      CREATE INDEX idx_transactions_created_at ON transactions(created_at);

      CREATE TABLE processed_events (
        event_id            TEXT    PRIMARY KEY,
        connection_id       INTEGER REFERENCES connections(id),
        method              TEXT,
        processed_at        INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    description: 'boltz_swaps table backing the SwapRepository for @arkade-os/boltz-swap',
    sql: `
      CREATE TABLE boltz_swaps (
        id          TEXT    PRIMARY KEY,
        type        TEXT    NOT NULL,   -- 'reverse' | 'submarine' | 'chain'
        status      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        data        TEXT    NOT NULL    -- JSON blob of the full BoltzSwap object
      );
      CREATE INDEX idx_boltz_swaps_status ON boltz_swaps(status);
      CREATE INDEX idx_boltz_swaps_type ON boltz_swaps(type);
      CREATE INDEX idx_boltz_swaps_created_at ON boltz_swaps(created_at);
    `,
  },
  {
    version: 3,
    description: 'accounts table — Ark identity moves from ARK_NSEC env var to here',
    // Schema permits multiple rows but the bridge only loads the first by id.
    // Multi-account would need history/connection scoping changes far beyond
    // a schema tweak, so for now treat "the account" as `ORDER BY id LIMIT 1`.
    sql: `
      CREATE TABLE accounts (
        id          INTEGER PRIMARY KEY,
        nsec_hex    TEXT    NOT NULL,
        created_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    description: 'connections.relays_json — per-connection relay list from outbox at create time',
    // Each NWC client is pinned to whatever relays the outbox watcher
    // resolved when its connection was created. Storing them here lets
    // the bridge keep listening on each connection's original relays
    // even after the outbox list changes, so existing clients keep
    // working without a revoke+reissue dance. New rows always get a
    // non-empty list via createConnection; the empty-array default is
    // only for the column shape and won't apply to live rows.
    sql: `
      ALTER TABLE connections ADD COLUMN relays_json TEXT NOT NULL DEFAULT '[]';
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
