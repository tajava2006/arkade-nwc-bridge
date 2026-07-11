import { base64, hex } from '@scure/base'
import {
  ChainTxType,
  DefaultVtxo,
  OnchainWallet,
  SingleKey,
  Transaction,
  type ChainTx,
} from '@arkade-os/sdk'
import type { VaultProofTx, VaultVtxoSnapshot } from '../../src/exit/vault'

export const ANCHOR_SCRIPT_HEX = '51024e73' // zero-value P2A, same bytes arkd emits

// A REAL exit-proof shape, signed but not finalized — exactly what
// getVirtualTxs serves: Unroll.Session runs tx.finalize() on ARK/CHECKPOINT
// entries (needs a valid signature in the PSBT) and lifts input 0's
// tapKeySig for TREE entries (a p2tr keyspend signature doubles as one).
// Built from a deterministic key so engine-level tests can drive the actual
// SDK session over synthetic vaults instead of mainnet dumps (which must
// never be committed — EXIT_PLAN §6 fixture privacy).
export interface SignedExitFixture {
  /** key that owns the vtxo (signs the exit-path sweep) */
  identity: SingleKey
  /** the vtxo's own tx — the thing Session broadcasts last */
  txid: string
  psbtB64: string
  /** fake commitment ancestor — chain marks it COMMITMENT so Session skips it */
  parentTxid: string
  chain: ChainTx[]
  proofs: VaultProofTx[]
  vtxo: VaultVtxoSnapshot
}

// Exit-path timelock baked into fixture tapTrees — short so CSV tests can
// advance a mock tip past it without huge numbers.
export const FIXTURE_CSV_BLOCKS = 10n

export async function makeSignedExitFixture(
  seed: number,
  opts: { chainType?: ChainTxType; valueSat?: number; identity?: SingleKey } = {},
): Promise<SignedExitFixture> {
  const chainType = opts.chainType ?? ChainTxType.ARK
  const valueSat = opts.valueSat ?? 10_000

  // one wallet key owns every vtxo in real life — batch-sweep tests pass a
  // shared identity while the seed keeps parent txids distinct
  const identity = opts.identity ?? SingleKey.fromPrivateKey(new Uint8Array(32).fill(seed))
  // OnchainWallet.create is network-free (provider stays lazy); it hands us a
  // ready-made p2tr payment for the identity, same shape arkd locks vtxos to
  const wallet = await OnchainWallet.create(identity, 'bitcoin')
  const p2tr = wallet.onchainP2TR

  const parent = new Transaction({ allowUnknownOutputs: true })
  parent.addInput({ txid: new Uint8Array(32).fill(seed ^ 0xff), index: 0 })
  parent.addOutput({ script: p2tr.script, amount: BigInt(valueSat) })
  parent.addOutput({ script: hex.decode(ANCHOR_SCRIPT_HEX), amount: 0n })

  const child = new Transaction({ allowUnknownOutputs: true })
  child.addInput({
    txid: parent.id,
    index: 0,
    witnessUtxo: { script: p2tr.script, amount: BigInt(valueSat) },
    tapInternalKey: p2tr.tapInternalKey,
  })
  child.addOutput({ script: p2tr.script, amount: BigInt(valueSat) })
  child.addOutput({ script: hex.decode(ANCHOR_SCRIPT_HEX), amount: 0n })

  const signed = await identity.sign(child)
  const txid = signed.id

  // Real encoded vtxo script (user+server collaborative path + CSV exit
  // path) so the CSV helper and the sweep path (#10) work against fixtures.
  const serverKey = SingleKey.fromPrivateKey(new Uint8Array(32).fill(0xa5))
  const tapTree = hex.encode(
    new DefaultVtxo.Script({
      pubKey: await identity.xOnlyPublicKey(),
      serverPubKey: await serverKey.xOnlyPublicKey(),
      csvTimelock: { type: 'blocks', value: FIXTURE_CSV_BLOCKS },
    }).encode(),
  )
  const chain: ChainTx[] = [
    { txid, type: chainType, expiresAt: '1783431985', spends: [parent.id] },
    { txid: parent.id, type: ChainTxType.COMMITMENT, expiresAt: '1783431985', spends: [] },
  ]
  return {
    identity,
    txid,
    psbtB64: base64.encode(signed.toPSBT()),
    parentTxid: parent.id,
    chain,
    proofs: [{ txid, type: chainType, psbtB64: base64.encode(signed.toPSBT()) }],
    vtxo: {
      txid,
      vout: 0,
      valueSat,
      script: hex.encode(p2tr.script),
      tapTree,
      status: 'preconfirmed',
      expiresAt: 1783431985,
      chain,
    },
  }
}

// Chain simulator: txs start unknown, broadcasting via the bumper confirms
// them instantly (skips Session's 5s mempool poll), the tip is hand-advanced
// to run CSV clocks, and every raw broadcast is captured for inspection.
export function makeMockChain(startHeight = 1_000) {
  const confirmed = new Map<string, { height: number; time: number }>()
  let tip = { height: startHeight, time: startHeight * 600, hash: 'h' }
  const broadcasts: string[][] = []
  const explorer = {
    async getTxStatus(txid: string) {
      const c = confirmed.get(txid)
      if (!c) throw new Error('not found')
      return { confirmed: true, blockHeight: c.height, blockTime: c.time }
    },
    async broadcastTransaction(...txs: string[]) {
      broadcasts.push(txs)
      return 'ok'
    },
    async getChainTip() {
      return tip
    },
    async getFeeRate() {
      return 2
    },
  }
  return {
    explorer,
    broadcasts,
    confirm(txid: string) {
      confirmed.set(txid, { height: tip.height, time: tip.time })
    },
    advance(blocks: number) {
      tip = { ...tip, height: tip.height + blocks, time: tip.time + blocks * 600 }
    },
  }
}
