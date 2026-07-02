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
  {
    version: 5,
    description: 'offboards table — bridge-native collaborative-exit tracking',
    // Onchain sends are the one rail that can take >10 min (they wait for a
    // settlement round to commit), so the web POST fires the offboard and
    // returns immediately rather than blocking. This table is the durable
    // record of those in-flight/finished exits: wallet.getTransactionHistory()
    // only surfaces an offboard once its commitment tx is final, so without
    // this the pending window — and any round failure — would be invisible.
    // Separate from `transactions` (that one is NWC/LN-shaped: connection_id
    // NOT NULL, invoice/payment_hash NOT NULL); an offboard has none of those.
    sql: `
      CREATE TABLE offboards (
        id           INTEGER PRIMARY KEY,
        address      TEXT    NOT NULL,    -- destination onchain address
        amount_sat   INTEGER NOT NULL,    -- sats landing at the destination (after intent fee)
        fee_sat      INTEGER NOT NULL,    -- arkd onchain-output intent fee deducted
        is_max       INTEGER NOT NULL,    -- 1 = full drain (amount omitted to the SDK)
        state        TEXT    NOT NULL,    -- 'pending' | 'settled' | 'failed'
        ark_txid     TEXT,                -- commitment txid once the round commits
        error        TEXT,
        created_at   INTEGER NOT NULL,
        settled_at   INTEGER
      );
      CREATE INDEX idx_offboards_state ON offboards(state);
      CREATE INDEX idx_offboards_created_at ON offboards(created_at);
    `,
  },
  {
    version: 6,
    description: 'clink_offer — single-row store for the static noffer receive code',
    // The dashboard's static CLINK noffer code. We persist the *encoded
    // string* (not its parts): it's the exact value people may have saved,
    // and we decode it on boot to recover the relay to listen on — so the
    // listen relay is frozen at mint time, immune to the operator's NIP-65
    // outbox drifting underneath (mirrors connections.relays_json). A noffer
    // carries only ONE relay (spec TLV 1 is singular), so there's nothing to
    // listen on but that one; if it dies the operator regenerates by hand.
    // Exactly one row (id=1, upserted) — a static handle, replaced not
    // accumulated.
    sql: `
      CREATE TABLE clink_offer (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        noffer     TEXT    NOT NULL,   -- the noffer1… bech32 string
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 7,
    description: 'clink_offer_receipts — pending CLINK payment receipts per offer swap',
    // To send the spec's optional CLINK Payment Receipt (kind 21001
    // {res:ok,preimage}) we must, at invoice-issue time, remember who to
    // ack and where — the payer pubkey, their request event id, and the
    // relay the request arrived on (the payer listens for the reply there;
    // it may differ from the *current* offer relay if the code was
    // regenerated in between). Keyed on the reverse-swap id so the swap's
    // onSwapCompleted callback can look the row up, publish the receipt, and
    // delete it. Persisted (not in-memory) so a restart between pay and
    // settle still lets us ack. No connection_id, no invoice — doesn't fit
    // the NWC-shaped transactions table.
    sql: `
      CREATE TABLE clink_offer_receipts (
        swap_id      TEXT PRIMARY KEY,
        payer_pubkey TEXT    NOT NULL,
        request_id   TEXT    NOT NULL,
        relay        TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
    `,
  },
  {
    version: 8,
    description: 'clink_subdust_receipts — pending CLINK receipts for sub-dust receives',
    // Sub-dust receives don't create a Boltz swap (no swap_id), so they can't
    // ride clink_offer_receipts. Same payer/request/relay info, keyed on the
    // invoice payment hash instead. The ack reconciler asks boltz
    // (/v2/subdust/receive/status) whether the invoice settled and, if so,
    // publishes the receipt and deletes the row. Persisted so a restart between
    // issue and settle still acks; a TTL pass drops never-paid rows.
    sql: `
      CREATE TABLE clink_subdust_receipts (
        payment_hash TEXT PRIMARY KEY,
        payer_pubkey TEXT    NOT NULL,
        request_id   TEXT    NOT NULL,
        relay        TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
    `,
  },
  {
    version: 9,
    description: 'zap columns on clink receipt tables — NIP-57 zap (9735) support',
    // A CLINK offer request can carry a NIP-57 zap payload (a kind-9734 event
    // in the `zap` field). When it does, we mint a descriptionHash invoice
    // committing SHA256(the exact 9734 string) and, on settlement, publish a
    // kind-9735 zap receipt to the relays named in the 9734. Both are needed at
    // settle time and settle happens later (possibly after a restart), so we
    // persist them alongside the existing receipt rows:
    //   zap_request — the exact 9734 JSON string (byte-identical to what the
    //                 descriptionHash was computed over, so it doubles as the
    //                 9735 `description` tag: SHA256(it) == invoice hash).
    //   zap_invoice — the BOLT11, needed for the 9735 `bolt11` tag (not
    //                 reconstructable from the payment hash).
    // Both NULL for non-zap (plain spontaneous) receives — those still only get
    // the CLINK Payment Receipt, no 9735. Nullable ADD COLUMN, so pre-zap rows
    // and the whole plain path are unaffected.
    sql: `
      ALTER TABLE clink_offer_receipts   ADD COLUMN zap_request TEXT;
      ALTER TABLE clink_offer_receipts   ADD COLUMN zap_invoice TEXT;
      ALTER TABLE clink_subdust_receipts ADD COLUMN zap_request TEXT;
      ALTER TABLE clink_subdust_receipts ADD COLUMN zap_invoice TEXT;
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
