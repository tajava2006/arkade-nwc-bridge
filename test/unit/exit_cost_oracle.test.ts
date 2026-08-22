import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { ChainTxType, type ChainTx } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { makeSpendEvidence, fakeTxid } from '../helpers/evidence'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { estimateExit } from '../../src/exit/estimate'
import { makeExitCostOracle } from '../../src/exit/cost_oracle'

// The oracle is what turns "which coin do I spend" into an economic question
// (coin_select.ts), so its two failure modes both matter: over-counting a chain
// makes a clean coin look written off, and throwing takes the send path down.

let t: TempDb
let db: Database
beforeEach(() => {
  t = openTempDb()
  db = t.db
})
afterEach(() => t.cleanup())

const VTXO = { txid: fakeTxid(0x11), vout: 0 }

/** Store a vault row whose chain lists `entries`, with a proof for each txid. */
function plantChain(entries: { txid: string; type: ChainTxType }[]): void {
  const seen = new Map<string, string>()
  for (const e of entries) {
    if (seen.has(e.txid)) continue
    seen.set(e.txid, makeSpendEvidence(7, { txid: e.txid, vout: 0 }).psbtB64)
  }
  const chain: ChainTx[] = entries.map((e) => ({
    txid: e.txid,
    type: e.type,
    expiresAt: '0',
    spends: [],
  }))
  storeVtxoWithProofs(
    db,
    {
      ...VTXO,
      valueSat: 50_000,
      source: 'wallet',
      script: 'aa'.repeat(32),
      tapTree: '',
      status: 'settled',
      expiresAt: null,
      chain,
    },
    [...seen].map(([txid, psbtB64]) => ({ txid, type: ChainTxType.ARK, psbtB64 })),
  )
}

describe('estimateExit — shared ancestors are counted once', () => {
  test('a txid re-emitted by the BFS does not inflate packages or vB', () => {
    // arkd's getVtxoChain is a BFS over a DAG and re-emits a shared ancestor at
    // each depth it is reached from (chain_order.ts documents it; stepper.ts
    // already dedupes). Broadcasting needs each tx once — and diamonds are
    // exactly what multi-input spends create, i.e. what the merge-averse coin
    // policy is reasoning about.
    const a = fakeTxid(0x21)
    const b = fakeTxid(0x22)

    plantChain([{ txid: a, type: ChainTxType.ARK }])
    const single = estimateExit(db, VTXO.txid, VTXO.vout, 5)!

    plantChain([
      { txid: a, type: ChainTxType.ARK },
      { txid: b, type: ChainTxType.ARK },
      { txid: a, type: ChainTxType.ARK }, // the re-emission
    ])
    const diamond = estimateExit(db, VTXO.txid, VTXO.vout, 5)!

    expect(single.packages).toBe(1)
    expect(diamond.packages).toBe(2) // a + b, not a + b + a
    expect(diamond.parentVb).toBe(single.parentVb * 2)
  })

  test('COMMITMENT entries stay excluded (they are chain metadata, not proofs)', () => {
    plantChain([
      { txid: fakeTxid(0x31), type: ChainTxType.ARK },
      { txid: fakeTxid(0x32), type: ChainTxType.COMMITMENT },
    ])
    expect(estimateExit(db, VTXO.txid, VTXO.vout, 5)!.packages).toBe(1)
  })
})

describe('makeExitCostOracle', () => {
  test('prices a known chain above zero and memoizes it', () => {
    plantChain([{ txid: fakeTxid(0x41), type: ChainTxType.ARK }])
    const oracle = makeExitCostOracle(db)
    const first = oracle(VTXO)
    expect(first).toBeGreaterThan(0)
    // Second read must not re-walk the vault — same answer, and still correct
    // after the row is gone (proving it came from the memo).
    db.query('DELETE FROM exit_vtxos').run()
    expect(oracle(VTXO)).toBe(first)
  })

  test('an unpriceable coin reads as 0 — "assume pristine", never a throw', () => {
    // No vault row at all: the send path must not care. Treating it as clean
    // just means the policy prefers to spend something it HAS priced.
    const oracle = makeExitCostOracle(db)
    expect(oracle({ txid: fakeTxid(0x51), vout: 0 })).toBe(0)
  })

  test('a corrupt proof row degrades to 0 instead of breaking the send', () => {
    plantChain([{ txid: fakeTxid(0x61), type: ChainTxType.ARK }])
    db.query('UPDATE exit_proof_txs SET psbt_base64 = ?').run('not-a-psbt')
    expect(makeExitCostOracle(db)(VTXO)).toBe(0)
  })
})
