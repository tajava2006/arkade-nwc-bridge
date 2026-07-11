import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { base64, hex } from '@scure/base'
import { ChainTxType, Transaction, type ChainTx, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { isVtxoExitReady } from '../../src/exit/vault'
import type { ProofSyncIndexer } from '../../src/exit/proof_sync'
import { startProofSync, type ProofSyncService } from '../../src/exit/sync_service'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeProof(seedByte: number): { txid: string; psbtB64: string } {
  const tx = new Transaction({ allowUnknownOutputs: true })
  tx.addInput({ txid: new Uint8Array(32).fill(seedByte), index: 0 })
  tx.addOutput({ script: hex.decode('51024e73'), amount: 0n })
  return { txid: tx.id, psbtB64: base64.encode(tx.toPSBT()) }
}

const ark = makeProof(9)
const chain: ChainTx[] = [
  { txid: ark.txid, type: ChainTxType.ARK, expiresAt: '1783431985', spends: ['c'.repeat(64)] },
  { txid: 'c'.repeat(64), type: ChainTxType.COMMITMENT, expiresAt: '1783431985', spends: [] },
]
const vtxo = {
  txid: ark.txid,
  vout: 0,
  value: 1000,
  script: '5120' + 'ab'.repeat(32),
  tapTree: hex.decode('c0de'),
  virtualStatus: { state: 'preconfirmed', batchExpiry: 1783431985000 },
} as unknown as ExtendedVirtualCoin

// Millisecond-scale timing so the scheduler's debounce/retry behavior is
// observable without slowing the suite down.
const TIMING = { debounceMs: 5, retryDelaysMs: [30], pollIntervalMs: 1_000_000 }

describe('proof sync service (scheduler)', () => {
  let temp: TempDb
  let svc: ProofSyncService | undefined
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    svc?.stop()
    temp.cleanup()
  })

  function deps(txs: Map<string, string>, opts: { listDelayMs?: number } = {}) {
    let listCalls = 0
    const indexer: ProofSyncIndexer = {
      async getVtxoChain() {
        return { chain, page: { current: 0, next: 0, total: 1 } }
      },
      async getVirtualTxs(txids) {
        const found = txids.map((id) => txs.get(id)).filter((x): x is string => !!x)
        return { txs: found, page: { current: 0, next: 0, total: 1 } }
      },
    }
    return {
      indexer,
      listCalls: () => listCalls,
      listVtxos: async () => {
        listCalls++
        if (opts.listDelayMs) await sleep(opts.listDelayMs)
        return [vtxo]
      },
    }
  }

  test('a burst of triggers collapses into one pass', async () => {
    const d = deps(new Map([[ark.txid, ark.psbtB64]]))
    const updates: boolean[] = []
    svc = startProofSync({ db: temp.db, indexer: d.indexer, listVtxos: d.listVtxos, timing: TIMING })
    svc.onUpdate((snap) => updates.push(snap.running))

    svc.trigger('a')
    svc.trigger('b')
    svc.trigger('c')
    await sleep(60)

    expect(d.listCalls()).toBe(1)
    const snap = svc.snapshot()
    expect(snap.lastRun?.reason).toBe('c') // last trigger's reason wins the debounce
    expect(snap.lastRun?.synced).toEqual([`${ark.txid}:0`])
    expect(snap.stats.readyCount).toBe(1)
    expect(updates).toEqual([true, false]) // running-edge then done-edge
  })

  test('gaps self-retry until the indexer serves the missing proof', async () => {
    const txs = new Map<string, string>() // proof not served yet
    const d = deps(txs)
    svc = startProofSync({ db: temp.db, indexer: d.indexer, listVtxos: d.listVtxos, timing: TIMING })

    svc.trigger('boot')
    await sleep(20)
    expect(svc.snapshot().lastRun?.failed).toHaveLength(1)
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(false)

    // indexer catches up before the 30ms retry fires
    txs.set(ark.txid, ark.psbtB64)
    await sleep(60)

    const snap = svc.snapshot()
    expect(snap.lastRun?.reason).toBe('retry')
    expect(snap.lastRun?.failed).toEqual([])
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(true)
  })

  test('a trigger landing mid-pass queues exactly one follow-up', async () => {
    const d = deps(new Map([[ark.txid, ark.psbtB64]]), { listDelayMs: 30 })
    svc = startProofSync({ db: temp.db, indexer: d.indexer, listVtxos: d.listVtxos, timing: TIMING })

    svc.trigger('first')
    await sleep(15) // first pass is now inside the slow listVtxos
    svc.trigger('during-1')
    await sleep(8)
    svc.trigger('during-2')
    await sleep(120)

    expect(d.listCalls()).toBe(2) // first pass + one coalesced follow-up
  })

  test('stop() makes further triggers inert', async () => {
    const d = deps(new Map([[ark.txid, ark.psbtB64]]))
    svc = startProofSync({ db: temp.db, indexer: d.indexer, listVtxos: d.listVtxos, timing: TIMING })
    svc.stop()
    svc.trigger('late')
    await sleep(30)
    expect(d.listCalls()).toBe(0)
  })

  test('claim records the last successful listVtxos and survives an outage', async () => {
    const d = deps(new Map([[ark.txid, ark.psbtB64]]))
    let aspDown = false
    svc = startProofSync({
      db: temp.db,
      indexer: d.indexer,
      listVtxos: async () => {
        if (aspDown) throw new Error('asp unreachable')
        return d.listVtxos()
      },
      timing: TIMING,
    })

    expect(svc.snapshot().claim).toBeNull() // no pass yet — nothing claimed

    svc.trigger('boot')
    await sleep(20)
    expect(svc.snapshot().claim?.total).toBe(1)

    // a pass that dies inside listVtxos records a failed run, but must not
    // rewrite the claim — an outage is not the server claiming zero vtxos
    aspDown = true
    svc.trigger('outage')
    await sleep(20)
    const snap = svc.snapshot()
    expect(snap.lastRun?.failed[0]?.outpoint).toBe('*')
    expect(snap.claim?.total).toBe(1)
  })
})
