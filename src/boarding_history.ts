import type { Database } from 'bun:sqlite'
import { recordOnboardPending, settleOnboard } from './history'
import type { NotifyFn } from './nostr/notifier'

// Onchain-deposit watcher — RECORDING only. Conversion is not our job: the
// SDK's VtxoManager poll already auto-settles confirmed boarding UTXOs into
// Arkade (settlementConfig is on in wallet.ts), but it exposes no event for
// it, so history has to observe the boarding set from outside: a new outpoint
// is a deposit, an outpoint that left the set was settled. Every observation
// is watermarked in boarding_seen so restarts never re-announce.
//
// Two deliberate judgment calls (HISTORY_DESIGN.md):
//  - First pass ever baselines whatever is already in the set without minting
//    rows — "no backfill": an operator importing an old seed must not get
//    years of deposits re-announced. A genuinely fresh wallet baselines an
//    empty set, so nothing is lost there.
//  - A boarding UTXO funded by our own boarding outpoints is the VtxoManager's
//    expired-boarding sweep (rotation), not a new deposit — suppressed. The
//    original deposit's row was already terminalized when its outpoint left
//    the set; the rotated UTXO then lives outside history until it settles.

interface BoardingUtxoLike {
  txid: string
  vout: number
  value: number
}

export interface BoardingHistoryDeps {
  db: Database
  /** wallet.getBoardingUtxos() — throws on network failure (pass aborts). */
  getBoardingUtxos(): Promise<BoardingUtxoLike[]>
  /**
   * Esplora reads, both best-effort:
   *  - outspend(txid, vout): {spent, txid?} — null when unreachable
   *  - txInputs(txid): funding tx's input outpoints — null when unreachable
   */
  esplora: {
    outspend(txid: string, vout: number): Promise<{ spent: boolean; txid: string | null } | null>
    txInputs(txid: string): Promise<Array<{ txid: string; vout: number }> | null>
  }
  notify?: NotifyFn
  log?: (msg: string) => void
}

interface SeenRow {
  txid: string
  vout: number
  kind: string
}

const nowSec = (): number => Math.floor(Date.now() / 1000)
const SENTINEL = { txid: '', vout: -1 }

function markSeen(db: Database, txid: string, vout: number, kind: string): void {
  db.query(
    `INSERT INTO boarding_seen (txid, vout, kind, first_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(txid, vout) DO UPDATE SET kind = excluded.kind`,
  ).run(txid, vout, kind, nowSec())
}

/**
 * One watcher pass. Ordering matters: new arrivals are classified before
 * departures are settled, so a sweep observed mid-rotation can't first count
 * as a deposit.
 */
export async function reconcileBoardingHistory(deps: BoardingHistoryDeps): Promise<void> {
  const { db } = deps
  const utxos = await deps.getBoardingUtxos()

  const seen = new Map<string, SeenRow>()
  for (const row of db
    .query<SeenRow, []>('SELECT txid, vout, kind FROM boarding_seen')
    .all()) {
    seen.set(`${row.txid}:${row.vout}`, row)
  }

  // First pass ever: baseline the current set, mint no rows.
  if (!seen.has(`${SENTINEL.txid}:${SENTINEL.vout}`)) {
    for (const u of utxos) markSeen(db, u.txid, u.vout, 'baseline')
    markSeen(db, SENTINEL.txid, SENTINEL.vout, 'init')
    if (utxos.length > 0) {
      deps.log?.(`boarding: baselined ${utxos.length} pre-existing boarding utxo(s), no history rows`)
    }
    return
  }

  const current = new Set(utxos.map((u) => `${u.txid}:${u.vout}`))

  // New arrivals: deposit unless funded by our own boarding outpoints (sweep).
  for (const u of utxos) {
    if (seen.has(`${u.txid}:${u.vout}`)) continue

    let isSweep = false
    const inputs = await deps.esplora.txInputs(u.txid)
    if (inputs) {
      isSweep = inputs.some((i) => seen.has(`${i.txid}:${i.vout}`))
    }
    // Esplora unreachable → classify as deposit. Wrong only for a sweep
    // happening exactly while esplora is down — rare enough that a visible
    // (deletable-by-reset, correct-amount) extra row beats missing a real
    // deposit.

    markSeen(db, u.txid, u.vout, isSweep ? 'sweep' : 'deposit')
    if (isSweep) {
      deps.log?.(`boarding: ${u.txid.slice(0, 12)}…:${u.vout} is our own boarding sweep — not a deposit`)
      continue
    }
    recordOnboardPending(db, { txid: u.txid, vout: u.vout, amountSats: u.value })
    deps.log?.(`boarding: onchain deposit detected — ${u.value} sats (${u.txid.slice(0, 12)}…:${u.vout})`)
    deps.notify?.('onboard', () => `recv: onchain deposit detected — ${u.value.toLocaleString()} sats (${u.txid.slice(0, 12)}…)`)
  }

  // Departures: an announced deposit left the boarding set. Only believe it
  // once esplora confirms the outpoint is actually spent — getBoardingUtxos
  // returning a short list for transient reasons must not mark rows settled.
  // Esplora unreachable → skip, retry next pass.
  for (const row of seen.values()) {
    if (row.kind !== 'deposit' && row.kind !== 'sweep' && row.kind !== 'baseline') continue
    if (current.has(`${row.txid}:${row.vout}`)) continue

    const outspend = await deps.esplora.outspend(row.txid, row.vout)
    if (!outspend?.spent) continue

    markSeen(db, row.txid, row.vout, 'spent')
    if (row.kind === 'deposit') {
      const ref = `${row.txid}:${row.vout}`
      settleOnboard(db, ref, outspend.txid)
      deps.log?.(`boarding: deposit ${row.txid.slice(0, 12)}…:${row.vout} settled into Arkade`)
      deps.notify?.('onboard', () => `recv: onchain deposit ${row.txid.slice(0, 12)}… settled into Arkade`)
    }
  }
}

/** Esplora REST reads for the watcher — plain fetch, null on any failure. */
export function makeBoardingEsplora(baseUrl: string, timeoutMs = 10_000): BoardingHistoryDeps['esplora'] {
  const get = async (path: string): Promise<unknown | null> => {
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }
  return {
    async outspend(txid, vout) {
      const body = (await get(`/tx/${txid}/outspend/${vout}`)) as
        | { spent?: boolean; txid?: string }
        | null
      if (!body || typeof body.spent !== 'boolean') return null
      return { spent: body.spent, txid: body.txid ?? null }
    },
    async txInputs(txid) {
      const body = (await get(`/tx/${txid}`)) as
        | { vin?: Array<{ txid?: string; vout?: number }> }
        | null
      if (!body || !Array.isArray(body.vin)) return null
      return body.vin
        .filter((v) => typeof v.txid === 'string' && typeof v.vout === 'number')
        .map((v) => ({ txid: v.txid as string, vout: v.vout as number }))
    },
  }
}
