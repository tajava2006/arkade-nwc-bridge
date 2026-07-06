import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SingleKey, Transaction, type OnchainProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { openTempDb, type TempDb } from '../helpers/db'
import { FIXTURE_CSV_BLOCKS, makeMockChain, makeSignedExitFixture } from '../helpers/exit'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { createOrRestartExitOp, getExitOp, setExitOpState } from '../../src/exit/ops'
import { sweepVtxos } from '../../src/exit/sweep'
import { startExitEngine, type ExitEngine } from '../../src/exit/engine'

const walletKey = SingleKey.fromPrivateKey(new Uint8Array(32).fill(7))

describe('exit sweep', () => {
  let temp: TempDb
  let engine: ExitEngine | undefined
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    engine?.stop()
    temp.cleanup()
  })

  async function sweepableFixture(seed: number, valueSat = 10_000) {
    const f = await makeSignedExitFixture(seed, { identity: walletKey, valueSat })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    setExitOpState(temp.db, f.txid, 0, 'sweepable')
    return f
  }

  function chainWithConfirmed(txids: string[]) {
    const chain = makeMockChain()
    for (const txid of txids) chain.confirm(txid)
    chain.advance(Number(FIXTURE_CSV_BLOCKS)) // CSV elapsed for everything above
    return chain
  }

  test('sweeps one vtxo through the CSV path to the given address', async () => {
    const f = await sweepableFixture(1)
    const chain = chainWithConfirmed([f.txid])
    const dest = 'bc1qs3rlfhcmd5flh6vl48an6mlyqfr5zm3v5kgl2n'

    const res = await sweepVtxos(
      {
        db: temp.db,
        identity: walletKey,
        explorer: chain.explorer as unknown as OnchainProvider,
        network: 'bitcoin',
      },
      [{ txid: f.txid, vout: 0 }],
      dest,
    )

    expect(chain.broadcasts).toHaveLength(1)
    const tx = Transaction.fromRaw(hex.decode(res.hex))
    expect(tx.inputsLength).toBe(1)
    expect(tx.outputsLength).toBe(1)
    expect(res.amountSat + res.feeSat).toBe(10_000)
    expect(res.amountSat).toBeGreaterThan(9_000) // ~140 vB at 2 sat/vB
    const input = tx.getInput(0)
    expect(input.sequence).toBe(Number(FIXTURE_CSV_BLOCKS)) // CSV encoded in nSequence
    expect(input.finalScriptWitness).toHaveLength(3) // [sig, leafScript, controlBlock]
  })

  test('refuses while the CSV clock is still running', async () => {
    const f = await sweepableFixture(2)
    const chain = makeMockChain()
    chain.confirm(f.txid) // confirmed, but tip never advanced

    expect(
      sweepVtxos(
        {
          db: temp.db,
          identity: walletKey,
          explorer: chain.explorer as unknown as OnchainProvider,
          network: 'bitcoin',
        },
        [{ txid: f.txid, vout: 0 }],
        'bc1qs3rlfhcmd5flh6vl48an6mlyqfr5zm3v5kgl2n',
      ),
    ).rejects.toThrow('CSV timelock not elapsed')
    expect(chain.broadcasts).toHaveLength(0)
  })

  test('refuses a sweep that would land below dust', async () => {
    const f = await sweepableFixture(3, 700) // 700 - ~280 fee < 546
    const chain = chainWithConfirmed([f.txid])

    expect(
      sweepVtxos(
        {
          db: temp.db,
          identity: walletKey,
          explorer: chain.explorer as unknown as OnchainProvider,
          network: 'bitcoin',
        },
        [{ txid: f.txid, vout: 0 }],
        'bc1qs3rlfhcmd5flh6vl48an6mlyqfr5zm3v5kgl2n',
      ),
    ).rejects.toThrow(/below dust|entire value/)
  })

  test('engine.sweep batches sweepable vtxos into one tx and marks them swept', async () => {
    const a = await sweepableFixture(4)
    const b = await sweepableFixture(5, 700) // alone: dust-doomed; batched: rides along
    const chain = chainWithConfirmed([a.txid, b.txid])

    engine = startExitEngine({
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      esploraUrls: ['http://127.0.0.1:1/api'],
      providers: {
        bumper: { bumpP2A: async (p: Transaction) => [p.hex, '<child>'] },
        explorer: chain.explorer as unknown as OnchainProvider,
      },
      pollIntervalMs: 60_000,
    })

    const res = await engine.sweep(
      [
        { txid: a.txid, vout: 0 },
        { txid: b.txid, vout: 0 },
      ],
      'bc1qs3rlfhcmd5flh6vl48an6mlyqfr5zm3v5kgl2n',
    )

    expect(res.inputCount).toBe(2)
    expect(res.amountSat + res.feeSat).toBe(10_700)
    for (const f of [a, b]) {
      const op = getExitOp(temp.db, f.txid, 0)
      expect(op?.state).toBe('swept')
      expect(op?.sweepTxid).toBe(res.txid)
    }
  })

  test('engine.sweep refuses ops that are not sweepable', async () => {
    const f = await makeSignedExitFixture(6, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0) // still 'unrolling'
    const chain = chainWithConfirmed([f.txid])

    engine = startExitEngine({
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      esploraUrls: ['http://127.0.0.1:1/api'],
      providers: {
        bumper: { bumpP2A: async (p: Transaction) => [p.hex, '<child>'] },
        explorer: chain.explorer as unknown as OnchainProvider,
      },
    })

    expect(engine.sweep([{ txid: f.txid, vout: 0 }])).rejects.toThrow('not sweepable')
  })

  test('default destination is the nsec-derived P2TR', async () => {
    const f = await sweepableFixture(8)
    const chain = chainWithConfirmed([f.txid])

    engine = startExitEngine({
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      esploraUrls: ['http://127.0.0.1:1/api'],
      providers: {
        bumper: { bumpP2A: async (p: Transaction) => [p.hex, '<child>'] },
        explorer: chain.explorer as unknown as OnchainProvider,
      },
    })

    const res = await engine.sweep([{ txid: f.txid, vout: 0 }])
    const op = getExitOp(temp.db, f.txid, 0)
    expect(op?.destAddress).toMatch(/^bc1p/) // plain taproot from the same key
    expect(res.amountSat).toBeGreaterThan(0)
  })
})
