import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Each migration is applied in order, exactly once. Append-only — never edit a
// previous entry's SQL, even to fix a typo, or older databases will diverge.
// Bump the version, write a new migration that corrects the prior one.
//
// 2026-07 schema-epoch reset: the first 16 incremental migrations were
// collapsed back into this single v1 while the operator DB was deliberately
// wiped (solo-user instance, test data only) — sixteen ALTERs had made the
// schema unreadable and there was no deployed data worth preserving. The
// incremental history lives in git before this commit. The append-only rule
// applies again from here; a pre-reset DB is refused at boot (applyMigrations).
interface Migration {
  version: number
  description: string
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'consolidated schema (2026-07 epoch reset)',
    sql: `
      -- One NWC client pairing per row. Each connection is pinned to the relay
      -- set the outbox watcher resolved at create time (relays_json): existing
      -- clients keep working even if the operator's NIP-65 list changes
      -- underneath, no revoke+reissue dance. spent_msat is the lifetime
      -- fee-inclusive wallet-movement counter backing the 'never' budget
      -- renewal (src/lib/budget.ts) — maintained for every renewal type so a
      -- row can later switch to 'never' without losing history.
      CREATE TABLE connections (
        id                  INTEGER PRIMARY KEY,
        label               TEXT,
        service_secret_hex  TEXT    NOT NULL,
        service_pubkey_hex  TEXT    NOT NULL UNIQUE,
        client_pubkey_hex   TEXT    NOT NULL,
        budget_msat         INTEGER,
        budget_renewal      TEXT    NOT NULL DEFAULT 'never',
        spent_msat          INTEGER NOT NULL DEFAULT 0,
        relays_json         TEXT    NOT NULL DEFAULT '[]',
        expires_at          INTEGER,
        created_at          INTEGER NOT NULL,
        revoked_at          INTEGER
      );
      CREATE INDEX idx_connections_client_pubkey ON connections(client_pubkey_hex);

      -- Single transactions table covering both NWC-side incoming (reverse
      -- swaps) and outgoing (submarine swaps). type discriminates, the rest of
      -- the columns are a union of what each side needs (incoming uses
      -- description / expires_at, outgoing uses error). This mirrors the
      -- NIP-47 transaction object shape — one shape with a type field — and
      -- how most LN wallet UIs surface history.
      --
      -- amount_msat is the BOLT11 nominal: the number payer and payee agreed
      -- on, and the one NIP-57 receipt validation compares against the zap
      -- request. fees_paid_msat is what WE paid to move it — the swap
      -- provider's cut, plus any drain residue donated on sends; NULL until
      -- known. The on-Ark wallet movement is always derived, never stored:
      -- incoming credits amount − fees, outgoing debits amount + fees.
      --
      -- Reads are connection-scoped and ordered by created_at DESC
      -- (list_transactions, lookup_invoice, the connection-detail page) — the
      -- composite index serves all of them. state stays indexed for the
      -- reconcilers' small high-selectivity pending scans.
      CREATE TABLE transactions (
        id                  INTEGER PRIMARY KEY,
        connection_id       INTEGER NOT NULL REFERENCES connections(id),
        type                TEXT    NOT NULL,    -- 'incoming' | 'outgoing'
        request_event_id    TEXT    NOT NULL UNIQUE,
        invoice             TEXT    NOT NULL,
        payment_hash        TEXT    NOT NULL,
        amount_msat         INTEGER NOT NULL,    -- BOLT11 nominal
        fees_paid_msat      INTEGER,             -- our cost, never the payer's
        description         TEXT,
        swap_id             TEXT,
        state               TEXT    NOT NULL,    -- 'pending' | 'settled' | 'failed' | 'expired'
        preimage            TEXT,
        error               TEXT,
        created_at          INTEGER NOT NULL,
        expires_at          INTEGER,
        settled_at          INTEGER
      );
      CREATE INDEX idx_transactions_payment_hash ON transactions(payment_hash);
      CREATE INDEX idx_transactions_state ON transactions(state);
      CREATE INDEX idx_transactions_conn_created ON transactions(connection_id, created_at);

      CREATE TABLE processed_events (
        event_id            TEXT    PRIMARY KEY,
        connection_id       INTEGER REFERENCES connections(id),
        method              TEXT,
        processed_at        INTEGER NOT NULL
      );

      -- Backs the SqliteSwapRepository for @arkade-os/boltz-swap: rows keyed
      -- on swap.id, the full BoltzSwap object stashed as a JSON blob.
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

      -- The Ark identity (created via /setup, recovered via show-nsec).
      -- Schema permits multiple rows but the bridge only loads the first by
      -- id — multi-account would need history/connection scoping changes far
      -- beyond a schema tweak, so "the account" is ORDER BY id LIMIT 1.
      CREATE TABLE accounts (
        id          INTEGER PRIMARY KEY,
        nsec_hex    TEXT    NOT NULL,
        created_at  INTEGER NOT NULL
      );

      -- Bridge-native collaborative exits. Onchain sends are the one rail
      -- that can take >10 min (they wait for a settlement round), so the web
      -- POST fires the offboard and returns; this is the durable record of
      -- the pending window and any round failure — getTransactionHistory()
      -- only surfaces an offboard once its commitment tx is final. Separate
      -- from transactions (that one is NWC/LN-shaped; an offboard has no
      -- connection, invoice, or payment hash). Same amount/fee split as
      -- transactions: amount_sat is what lands at the destination, fee_sat
      -- what we paid on top.
      CREATE TABLE offboards (
        id           INTEGER PRIMARY KEY,
        address      TEXT    NOT NULL,    -- destination onchain address
        amount_sat   INTEGER NOT NULL,    -- sats landing at the destination
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

      -- The dashboard's static CLINK noffer code. We persist the *encoded
      -- string* (not its parts): it's the exact value people may have saved,
      -- and decoding it on boot recovers the relay to listen on — frozen at
      -- mint time, immune to NIP-65 outbox drift (mirrors
      -- connections.relays_json). A noffer carries only ONE relay (spec TLV 1
      -- is singular); if it dies the operator regenerates by hand. Exactly
      -- one row (id=1, upserted) — a static handle, replaced not accumulated.
      CREATE TABLE clink_offer (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        noffer     TEXT    NOT NULL,   -- the noffer1… bech32 string
        created_at INTEGER NOT NULL
      );

      -- Pending CLINK payment receipts (kind 21001 {res:ok,preimage}): at
      -- invoice-issue time remember who to ack and where — the payer pubkey,
      -- their request event id, and the relay the request arrived on (it may
      -- differ from the *current* offer relay if the code was regenerated in
      -- between). Keyed on the reverse-swap id so onSwapCompleted can look
      -- the row up, publish the receipt, and delete it. Persisted (not
      -- in-memory) so a restart between pay and settle still acks.
      -- zap_request/zap_invoice carry NIP-57 support, both needed at settle
      -- time: the exact 9734 JSON string the descriptionHash was computed
      -- over (doubles as the 9735 description tag) and the BOLT11 for the
      -- 9735 bolt11 tag. Both NULL for plain non-zap receives.
      CREATE TABLE clink_offer_receipts (
        swap_id      TEXT PRIMARY KEY,
        payer_pubkey TEXT    NOT NULL,
        request_id   TEXT    NOT NULL,
        relay        TEXT    NOT NULL,
        zap_request  TEXT,
        zap_invoice  TEXT,
        created_at   INTEGER NOT NULL
      );

      -- Same ack bookkeeping for sub-dust receives, which create no Boltz
      -- swap object (no swap_id) — keyed on the invoice payment hash instead.
      -- The ack reconciler reads the local atomic_swaps row (settled by
      -- reconcileAtomicReceives) and publishes on settle; a TTL pass drops
      -- never-paid rows.
      CREATE TABLE clink_subdust_receipts (
        payment_hash TEXT PRIMARY KEY,
        payer_pubkey TEXT    NOT NULL,
        request_id   TEXT    NOT NULL,
        relay        TEXT    NOT NULL,
        zap_request  TEXT,
        zap_invoice  TEXT,
        created_at   INTEGER NOT NULL
      );

      -- Exit vault: locally persisted unilateral-exit proofs (EXIT_DESIGN.md).
      -- Unilateral exit must work with the ASP dead, but the SDK's unroll
      -- path fetches pre-signed PSBTs from the ASP's indexer at exit time.
      -- These two tables are the offline mirror, kept fresh by ProofSync
      -- while the ASP is alive; the exit engine reads only from here
      -- (+ esplora).
      --
      -- exit_proof_txs is keyed on txid: vtxo histories form a DAG, so one
      -- row per tx dedupes branches shared across vtxos. Rows are immutable;
      -- a pre-signed PSBT for a txid never legitimately changes.
      CREATE TABLE exit_proof_txs (
        txid          TEXT    PRIMARY KEY,
        type          TEXT    NOT NULL,    -- SDK ChainTxType string
        psbt_base64   TEXT    NOT NULL,    -- verbatim getVirtualTxs payload
        first_seen_at INTEGER NOT NULL
      );

      -- exit_vtxos snapshots what the sweep step needs when no Wallet object
      -- exists (value + tap_tree for exit paths/witnessUtxo) plus the ordered
      -- chain exactly as the indexer returned it (SDK ChainTx[] JSON — the
      -- Unroll.Session input). Completeness is not enforced here; readiness
      -- is recomputed by joining against exit_proof_txs (src/exit/vault.ts).
      -- GC is evidence-gated: a vtxo the ASP drops from the live set is only
      -- deleted on verifiable evidence (our own signature on the spending tx,
      -- or a locally-judged expiry). Rows failing that demand are quarantined
      -- instead — proofs retained, so the server's lie can't destroy the
      -- escape hatch. quarantined_at keeps the FIRST quarantine time across
      -- passes; reason is refreshed.
      CREATE TABLE exit_vtxos (
        txid              TEXT    NOT NULL,
        vout              INTEGER NOT NULL,
        value_sat         INTEGER NOT NULL,
        script            TEXT    NOT NULL,    -- pkScript hex (ownership cross-check)
        tap_tree          TEXT    NOT NULL,    -- EncodedVtxoScript.tapTree hex
        status            TEXT    NOT NULL,    -- virtualStatus.state snapshot (display only)
        expires_at        INTEGER,             -- batch expiry, unix seconds — the exit deadline
        chain_json        TEXT    NOT NULL,    -- ChainTx[] in indexer order
        quarantined_at    INTEGER,
        quarantine_reason TEXT,
        synced_at         INTEGER NOT NULL,
        PRIMARY KEY (txid, vout)
      );
      CREATE INDEX idx_exit_vtxos_expires_at ON exit_vtxos(expires_at);

      -- Unilateral-exit intent/progress, one row per vtxo the operator told
      -- the engine to exit. Deliberately a COARSE record: fine-grained unroll
      -- progress is re-derived from chain state every time (Unroll.Session
      -- skips what is already onchain), so a crash mid-exit needs no precise
      -- replay — resume just re-runs the session. States: unrolling →
      -- waiting (CSV timelock running) → sweepable → swept. failed is
      -- retryable — startExit on a failed row resets it.
      CREATE TABLE exit_ops (
        txid         TEXT    NOT NULL,
        vout         INTEGER NOT NULL,
        state        TEXT    NOT NULL,
        dest_address TEXT,               -- sweep destination override; NULL = nsec P2TR
        sweep_txid   TEXT,
        error        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (txid, vout)
      );
      CREATE INDEX idx_exit_ops_state ON exit_ops(state);

      -- Tip height at broadcast, for the "waiting N blocks" readout.
      -- Deliberately the ONLY thing recorded about a broadcast: everything
      -- else the boost path needs is derivable offline (the parent hex
      -- re-finalizes from the vault PSBT) or better read live from esplora
      -- (a stored CPFP child could be stale if anyone else bumped the
      -- anyone-can-spend anchor). step_txid keys the row: for unroll packages
      -- that's the pre-signed parent (immutable, so boosts never touch the
      -- row); a sweep RBF mints a new txid, so the boost inserts a new row
      -- carrying the old tip_height forward (the wait started at the first
      -- broadcast, not the replacement). Re-broadcast after a mempool
      -- eviction overwrites tip_height — that IS a new wait. tip_height is
      -- NULL when the tip read failed at broadcast time; the UI omits the
      -- counter.
      CREATE TABLE exit_broadcasts (
        step_txid  TEXT PRIMARY KEY,
        txid       TEXT    NOT NULL,
        vout       INTEGER NOT NULL,
        tip_height INTEGER,
        created_at INTEGER NOT NULL
      );

      -- Challenge-verified final-send destination (single row). The last exit
      -- step sends everything accumulated on the fuel P2TR to an address the
      -- user PROVED they control (signed our challenge with that address's
      -- key — a typo or clipboard swap can't produce a verifying signature).
      -- One row because there is one operator and one final destination at a
      -- time; issuing a new challenge replaces the row and voids any previous
      -- verification. Persisted because signing may involve a cold wallet on
      -- another machine — the challenge must survive a bridge restart.
      -- send_txid records the LATEST broadcast final send (an RBF boost
      -- overwrites it); fee/vsize are read live from esplora, never stored.
      CREATE TABLE exit_dest (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        address     TEXT    NOT NULL,
        challenge   TEXT    NOT NULL,
        issued_at   INTEGER NOT NULL,
        verified_at INTEGER,
        scheme      TEXT,
        send_txid   TEXT,
        sent_at     INTEGER
      );
    `,
  },
  {
    version: 2,
    description: 'atomic sub-dust swaps (ATOMIC_SUBDUST_PLAN.md §3.4)',
    // In-flight atomic sub-dust LN swaps. Pre-signatures / preimage / state must
    // survive a restart or the swap strands (can't refund, can't settle);
    // payment_hash is UNIQUE so an invoice can't be swapped twice. The current
    // DDL (with IF NOT EXISTS, for tests/standalone) lives in
    // src/atomic/repository.ts — this migration text is frozen (append-only).
    sql: `
      CREATE TABLE atomic_swaps (
        id                TEXT    PRIMARY KEY,
        direction         TEXT    NOT NULL,
        payment_hash      TEXT    NOT NULL UNIQUE,
        state             TEXT    NOT NULL,
        amount            INTEGER NOT NULL,
        refund_locktime   INTEGER NOT NULL,
        funding_outpoint  TEXT,
        presigs_json      TEXT,
        preimage          TEXT,
        invoice           TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_atomic_swaps_state ON atomic_swaps(state);
    `,
  },
  {
    version: 3,
    description: 'atomic swaps in the exit vault (ATOMIC_SUBDUST_PLAN.md §8 2026-07-16)',
    // In-flight atomic-send shared vtxos live at a script address the wallet
    // never lists, so ProofSync's wallet-driven passes can't mirror them and
    // the ASP dying mid-swap would leave no exit material. They are captured
    // into exit_vtxos explicitly at funding time; `source` marks such rows as
    // lifecycle-owned (the swap code deletes them on terminal states) so the
    // evidence-gated GC skips them instead of false-quarantining every pass.
    // peer_pubkey/exit_delay make a send row self-contained for the refund
    // path: rebuilding the 4-leaf script after a restart (or with boltz gone)
    // must not depend on boltz answering /send/init again.
    sql: `
      ALTER TABLE exit_vtxos ADD COLUMN source TEXT NOT NULL DEFAULT 'wallet';
      ALTER TABLE atomic_swaps ADD COLUMN peer_pubkey TEXT;
      ALTER TABLE atomic_swaps ADD COLUMN exit_delay INTEGER;
    `,
  },
  {
    version: 4,
    description: 'fresh-start server selection (ark+boltz), single immutable row',
    // The ASP the bridge talks to — an arkd + its matched boltz — is chosen once
    // at the first /setup and then frozen: there is no multi-server wallet, so
    // changing it means draining funds and starting over from a fresh sqlite.
    // Exactly one row (id=1, upserted), mirroring clink_offer / exit_dest. It is
    // resolved at bootReady with precedence data/config.json > this row >
    // defaults.ts (src/server_config.ts) — a stray config.json (the docker /
    // regtest override) still wins, so that path is unchanged. network/esplora
    // are deliberately NOT here: a chosen set is assumed mainnet (defaults.ts),
    // matching the atomic sub-dust mainnet hardcode (subdustSelfExitDelay).
    sql: `
      CREATE TABLE bridge_server (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        ark_url    TEXT    NOT NULL,
        boltz_url  TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    description: 'unified wallet history + boarding watermark (HISTORY_DESIGN.md)',
    // One row per wallet-level money event, every rail: NWC LN (mirrored from
    // `transactions` — that table stays NWC/NIP-47-shaped and connection-
    // scoped), web sends (LN / Ark offchain), CLINK noffer receives, onchain
    // boarding deposits, offboards. Deliberately a SEPARATE table from
    // `transactions`: its connection_id NOT NULL FK and 'incoming'/'outgoing'
    // type vocabulary are load-bearing for connection isolation and NIP-47
    // clients, so widening it would leak non-LN rows into NWC responses.
    //
    // Kinds with an authoritative source table (nwc_ln ← transactions,
    // offboard ← offboards) are inserted once and re-synced by
    // syncHistoryFromSources (src/history.ts) — a display cache, never a
    // second source of truth. (kind, ref) dedupes retry-prone inserts (the
    // noffer ack funnel re-runs until its receipt publishes); ref is NULL
    // where no natural key exists (failed ark sends) — SQLite UNIQUE treats
    // NULLs as distinct, i.e. deliberately no dedup there.
    //
    // Reads are ORDER BY created_at DESC, id DESC with a (created_at, id)
    // cursor. A single created_at index suffices: id aliases the rowid and
    // every SQLite index entry is (key, rowid), so idx_history_created_at
    // already is that composite.
    sql: `
      CREATE TABLE history (
        id          INTEGER PRIMARY KEY,
        kind        TEXT    NOT NULL,   -- 'nwc_ln' | 'web_ln' | 'noffer' | 'ark_send' | 'onboard' | 'offboard'
        direction   TEXT    NOT NULL,   -- 'in' | 'out'
        state       TEXT    NOT NULL,   -- 'pending' | 'settled' | 'failed' | 'expired'
        amount_msat INTEGER NOT NULL,   -- nominal (BOLT11 nominal for LN; onchain/ark sats * 1000)
        fees_msat   INTEGER,            -- our cost on top, NULL = unknown (same split as transactions)
        description TEXT,               -- human context: invoice desc, zap comment, destination address
        ref         TEXT,               -- dedup / sync key, unique per kind (src/history.ts)
        txid        TEXT,               -- ark txid, or the onchain funding txid for onboards
        txid2       TEXT,               -- onboard only: the spending (settlement round) txid
        error       TEXT,
        created_at  INTEGER NOT NULL,
        settled_at  INTEGER,
        UNIQUE (kind, ref)
      );
      CREATE INDEX idx_history_created_at ON history(created_at);

      -- Boarding-deposit watermark for the onboard watcher
      -- (src/boarding_history.ts). Every boarding outpoint ever observed, so
      -- restarts never re-announce a deposit and the first pass ever can
      -- baseline pre-existing UTXOs without minting history rows (no
      -- backfill by design — a re-imported seed must not resurrect years of
      -- old deposits). kind: 'init' single sentinel row (txid='', vout=-1)
      -- marking that the first pass ran | 'baseline' pre-existing at first
      -- pass, no history row | 'deposit' announced in history | 'sweep'
      -- funded by our own boarding UTXOs being rotated, not a deposit |
      -- 'spent' left the boarding set (terminal).
      CREATE TABLE boarding_seen (
        txid       TEXT    NOT NULL,
        vout       INTEGER NOT NULL,
        kind       TEXT    NOT NULL,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (txid, vout)
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

  // A DB carrying migration versions this build has never heard of is either
  // from before the 2026-07 epoch reset or from a newer build (a downgrade).
  // Running against it would silently mix schema conventions — the epoch
  // reset also changed what amount_msat *means* — so refuse loudly instead.
  const maxKnown = MIGRATIONS[MIGRATIONS.length - 1]!.version
  const maxApplied = Math.max(0, ...applied)
  if (maxApplied > maxKnown) {
    throw new Error(
      `database schema v${maxApplied} is newer than this build knows (v${maxKnown}) — ` +
        `a pre-epoch-reset DB or a downgrade. Back up the key (bun run show-nsec), ` +
        `move the sqlite file aside, and restart to start fresh.`,
    )
  }

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
