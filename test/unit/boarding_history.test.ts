import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { reconcileBoardingHistory, type BoardingHistoryDeps } from '../../src/boarding_history'
import type { HistoryRow } from '../../src/history'
import { openTempDb, type TempDb } from '../helpers/db'

let tmp: TempDb
let db: Database

beforeEach(() => {
  tmp = openTempDb()
  db = tmp.db
})
afterEach(() => tmp.cleanup())

interface Utxo {
  txid: string
  vout: number
  value: number
}

// Fake esplora: outspends/inputs are plain maps; entries absent → null
// (unreachable), present → the payload. Tests mutate them between passes.
function makeDeps(state: {
  utxos: Utxo[]
  outspends?: Record<string, { spent: boolean; txid: string | null }>
  inputs?: Record<string, Array<{ txid: string; vout: number }>>
}): BoardingHistoryDeps {
  return {
    db,
    getBoardingUtxos: async () => state.utxos,
    esplora: {
      outspend: async (txid, vout) => state.outspends?.[`${txid}:${vout}`] ?? null,
      txInputs: async (txid) => state.inputs?.[txid] ?? null,
    },
  }
}

const onboardRows = (): HistoryRow[] =>
  db.query<HistoryRow, []>(`SELECT * FROM history WHERE kind = 'onboard' ORDER BY id`).all()

const seenKinds = (): Map<string, string> =>
  new Map(
    db
      .query<{ txid: string; vout: number; kind: string }, []>(
        'SELECT txid, vout, kind FROM boarding_seen',
      )
      .all()
      .map((r) => [`${r.txid}:${r.vout}`, r.kind]),
  )

describe('reconcileBoardingHistory', () => {
  test('first pass baselines pre-existing utxos — no history rows, ever after', async () => {
    const state = { utxos: [{ txid: 'old', vout: 0, value: 10_000 }] }
    await reconcileBoardingHistory(makeDeps(state))
    expect(onboardRows()).toEqual([])
    expect(seenKinds().get('old:0')).toBe('baseline')

    // Second pass: still no row for the baselined utxo.
    await reconcileBoardingHistory(makeDeps(state))
    expect(onboardRows()).toEqual([])
  })

  test('fresh deposit after the baseline gets a pending row, announced once', async () => {
    const state: Parameters<typeof makeDeps>[0] = { utxos: [], inputs: {} }
    await reconcileBoardingHistory(makeDeps(state)) // arms the sentinel

    state.utxos = [{ txid: 'dep', vout: 0, value: 5000 }]
    state.inputs = { dep: [{ txid: 'external', vout: 3 }] }
    await reconcileBoardingHistory(makeDeps(state))
    await reconcileBoardingHistory(makeDeps(state)) // restart / next tick: no re-announce

    const rows = onboardRows()
    expect(rows.length).toBe(1)
    expect(rows[0]!.state).toBe('pending')
    expect(rows[0]!.amount_msat).toBe(5_000_000)
    expect(rows[0]!.ref).toBe('dep:0')
  })

  test('esplora down at classification time still records the deposit', async () => {
    const state: Parameters<typeof makeDeps>[0] = { utxos: [] }
    await reconcileBoardingHistory(makeDeps(state))
    state.utxos = [{ txid: 'dep', vout: 0, value: 700 }] // inputs map absent → txInputs null
    await reconcileBoardingHistory(makeDeps(state))
    expect(onboardRows().length).toBe(1)
  })

  test('a utxo funded by our own boarding outpoints is a sweep, not a deposit', async () => {
    const state: Parameters<typeof makeDeps>[0] = {
      utxos: [{ txid: 'old', vout: 0, value: 9000 }],
      inputs: {},
      outspends: {},
    }
    await reconcileBoardingHistory(makeDeps(state)) // baselines old:0

    // Rotation: old:0 spent by sweep tx, which funds a fresh boarding utxo.
    state.utxos = [{ txid: 'sweeptx', vout: 0, value: 8900 }]
    state.inputs = { sweeptx: [{ txid: 'old', vout: 0 }] }
    state.outspends = { 'old:0': { spent: true, txid: 'sweeptx' } }
    await reconcileBoardingHistory(makeDeps(state))

    expect(onboardRows()).toEqual([]) // neither the sweep nor the baselined origin
    expect(seenKinds().get('sweeptx:0')).toBe('sweep')
    expect(seenKinds().get('old:0')).toBe('spent')
  })

  test('departure settles only once esplora confirms the spend', async () => {
    const state: Parameters<typeof makeDeps>[0] = { utxos: [], inputs: {}, outspends: {} }
    await reconcileBoardingHistory(makeDeps(state))
    state.utxos = [{ txid: 'dep', vout: 0, value: 5000 }]
    state.inputs = { dep: [{ txid: 'ext', vout: 0 }] }
    await reconcileBoardingHistory(makeDeps(state))

    // Utxo vanishes from the SDK list, but esplora is unreachable → hold.
    state.utxos = []
    await reconcileBoardingHistory(makeDeps(state))
    expect(onboardRows()[0]!.state).toBe('pending')

    // Esplora answers "unspent" (transient short list) → still hold.
    state.outspends = { 'dep:0': { spent: false, txid: null } }
    await reconcileBoardingHistory(makeDeps(state))
    expect(onboardRows()[0]!.state).toBe('pending')

    // Spend confirmed → settled, with the settlement round txid attached.
    state.outspends = { 'dep:0': { spent: true, txid: 'round1' } }
    await reconcileBoardingHistory(makeDeps(state))
    const row = onboardRows()[0]!
    expect(row.state).toBe('settled')
    expect(row.txid2).toBe('round1')
    expect(seenKinds().get('dep:0')).toBe('spent')

    // Terminal: later passes never touch it again.
    await reconcileBoardingHistory(makeDeps(state))
    expect(onboardRows()[0]).toEqual(row)
  })

  test('getBoardingUtxos throwing aborts the pass without corrupting state', async () => {
    const state: Parameters<typeof makeDeps>[0] = { utxos: [], inputs: {} }
    await reconcileBoardingHistory(makeDeps(state))
    state.utxos = [{ txid: 'dep', vout: 0, value: 100 }]
    state.inputs = { dep: [] }
    await reconcileBoardingHistory(makeDeps(state))

    const deps = makeDeps(state)
    deps.getBoardingUtxos = async () => {
      throw new Error('esplora 502')
    }
    await expect(reconcileBoardingHistory(deps)).rejects.toThrow('esplora 502')
    expect(onboardRows()[0]!.state).toBe('pending') // untouched
  })
})
