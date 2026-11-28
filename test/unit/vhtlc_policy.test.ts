import { describe, expect, test } from 'bun:test'
import { hex } from '@scure/base'
import { createHash, randomBytes } from 'node:crypto'
import {
  buildVhtlc,
  checkReceiveBeforeClaim,
  checkSendOffer,
  CSV_UNIT_SECS,
  DEFAULT_VHTLC_POLICY,
  policyFor,
  receiveFundingMarginSecs,
  receiveTimeouts,
  ripemd160,
  roundUpCsv,
  sendFundingMinLifeSecs,
  sendTimeouts,
  SwapDirection,
  unrollBlocks,
  usesVhtlc,
  type OfferedVhtlc,
  type VhtlcPolicy,
  floatRenewThresholdSecs,
  receiveFundingLifeSecs,
} from '../../src/atomic'

// The VHTLC timing rules (my-server F32_VHTLC_PLAN.md §5). Each attack named in
// the plan is an inequality; these tests pin that the timeouts we propose
// satisfy it and that the other side's check refuses terms that break it.

const E = 86_016 // mainnet unilateralExitDelay, 2026-11-28
const p: VhtlcPolicy = { ...DEFAULT_VHTLC_POLICY, exitDelaySecs: E }
const NOW = 1_800_000_000
const slow = (blocks: number) => blocks * p.slowBlockSecs
const U = unrollBlocks(p)
const K = p.confirmBlocks
const sendArgs = { nowSecs: NOW, windowSecs: 324_000, payMarginSecs: 600, blockTimeSecs: 600 }

const csvOk = (s: number) => s % CSV_UNIT_SECS === 0 && s >= E

describe('policyFor — block assumptions come from the network, not the counterparty', () => {
  test('mainnet keeps the 9/11-minute bounds and an hour of MTP lag', () => {
    expect(policyFor(E, 'bitcoin')).toEqual({ ...DEFAULT_VHTLC_POLICY, exitDelaySecs: E })
  })
  test('regtest fits its 2-hour batches (E 2048, 1h send window, 10-minute invoices)', () => {
    const r = policyFor(2048, 'regtest')
    expect([r.fastBlockSecs, r.slowBlockSecs, r.mtpLagSecs]).toEqual([20, 30, 180])
    expect(sendFundingMinLifeSecs(r, 3_600)).toBeLessThan(7_200)
    const recv = receiveTimeouts(r, 0, 600)
    expect(recv.refundLocktime + receiveFundingMarginSecs(r)).toBeLessThan(7_200)
  })
})

describe('usesVhtlc — dust decides the script', () => {
  test('a send rides the VHTLC once a + fee is a real coin', () => {
    expect(usesVhtlc(SwapDirection.Send, 328, 2, 330)).toBe(true)
    expect(usesVhtlc(SwapDirection.Send, 327, 2, 330)).toBe(false)
  })
  test('a receive once a itself is', () => {
    expect(usesVhtlc(SwapDirection.Receive, 330, 0, 330)).toBe(true)
    expect(usesVhtlc(SwapDirection.Receive, 329, 0, 330)).toBe(false)
  })
})

describe('send timeouts (sender = user, receiver = subdustd)', () => {
  const t = sendTimeouts(p, sendArgs)

  test('every CSV is a 512-second multiple arkd will spend', () => {
    for (const s of [t.claimDelaySecs, t.refundDelaySecs, t.refundNoReceiverDelaySecs]) expect(csvOk(s)).toBe(true)
    expect(t.refundLocktime).toBe(NOW + 324_000)
  })

  test('S1: the user unrolls at funding and settles at the HTLC’s last block — subdustd’s claim still lands first', () => {
    const maxHtlcBlocks = Math.ceil((324_000 - 600) / 600)
    expect(t.refundNoReceiverDelaySecs).toBeGreaterThanOrEqual(slow(maxHtlcBlocks + K) + p.mtpLagSecs)
  })

  test('C1: subdustd’s on-chain claim matures K slow blocks before the user’s leaf', () => {
    expect(t.refundNoReceiverDelaySecs).toBeGreaterThanOrEqual(t.claimDelaySecs + slow(K))
  })

  test('S4: funding coins outlive T + an unroll, so a stalled swap can still be unrolled before the batch sweep', () => {
    expect(sendFundingMinLifeSecs(p, 324_000)).toBe(324_000 + slow(U + K) + p.mtpLagSecs)
  })
})

describe('checkSendOffer — the user vets subdustd’s send terms before funding', () => {
  const own = sendTimeouts(p, sendArgs)
  const vet = (o: OfferedVhtlc) => checkSendOffer(p, o, { nowSecs: NOW, maxWindowSecs: 324_000, payMarginSecs: 600, blockTimeSecs: 600 })

  test('our own terms pass', () => expect(vet(own)).toEqual([]))
  test('a T further out than the wallet accepts is refused', () => {
    expect(vet({ ...own, refundLocktime: NOW + 324_001 }).join()).toContain('more than')
    expect(vet({ ...own, refundLocktime: NOW }).join()).toContain('not in the future')
  })
  test('a d_s that would park the user’s on-chain fallback too long is refused', () => {
    expect(vet({ ...own, refundNoReceiverDelaySecs: roundUpCsv(own.refundNoReceiverDelaySecs * 1.3) }).join()).toContain('exceeds')
  })
  test('a leaf below arkd’s exit delay (an unspendable VHTLC) is refused', () => {
    expect(vet({ ...own, claimDelaySecs: E - CSV_UNIT_SECS }).join()).toContain('below arkd')
    expect(vet({ ...own, claimDelaySecs: E + 1 }).join()).toContain('multiple')
  })
})

describe('receive timeouts (sender = subdustd, receiver = user)', () => {
  const INVOICE_EXPIRY = 21_600
  const t = receiveTimeouts(p, NOW, INVOICE_EXPIRY)

  test('every CSV is a 512-second multiple arkd will spend', () => {
    for (const s of [t.claimDelaySecs, t.refundDelaySecs, t.refundNoReceiverDelaySecs]) expect(csvOk(s)).toBe(true)
  })

  test('R1: paid at the invoice’s last second, detect + unroll + d_c + confirm still fit before T', () => {
    const paidAt = NOW + INVOICE_EXPIRY
    expect(t.refundLocktime - paidAt).toBeGreaterThanOrEqual(t.claimDelaySecs + slow(p.detectBlocks + U + K))
  })

  test('C1/R5: the user’s claim leaf beats subdustd’s by K slow blocks', () => {
    expect(t.refundNoReceiverDelaySecs).toBeGreaterThanOrEqual(t.claimDelaySecs + slow(K))
  })

  test('R4: the HTLC outlives a claim made d_s after an unroll begun at T — counted in fast blocks', () => {
    const fast = (s: number) => Math.ceil(s / p.fastBlockSecs)
    expect(t.finalCltvBlocks).toBeGreaterThanOrEqual(fast(t.windowSecs) + U + fast(t.refundNoReceiverDelaySecs) + K + p.settleMarginBlocks)
    // R3 (a late off-chain claim) needs less, so R4 covers it.
    expect(t.finalCltvBlocks).toBeGreaterThan(fast(t.windowSecs) + p.settleMarginBlocks)
    // Within what every LND hop forwards.
    expect(t.finalCltvBlocks).toBeLessThan(2016)
  })
})

describe('checkReceiveBeforeClaim — the user vets a funded receive before showing the preimage', () => {
  const own = receiveTimeouts(p, NOW, 0)
  const fresh = { nowSecs: NOW, batchExpirySecs: own.refundLocktime + receiveFundingMarginSecs(p), vhtlcDepth: 3 }

  test('subdustd’s own terms on a coin it may fund from pass', () => expect(checkReceiveBeforeClaim(p, own, fresh)).toEqual([]))

  test('R1: too little time left to beat T on chain → no claim', () => {
    const late = { ...fresh, nowSecs: own.refundLocktime - own.claimDelaySecs - slow(p.detectBlocks + U + K) + 1 }
    expect(checkReceiveBeforeClaim(p, own, late).join()).toContain('on-chain claim needs')
  })

  test('R2: a batch that could expire under the unroll → no claim', () => {
    const expiring = { ...fresh, batchExpirySecs: NOW + slow(p.detectBlocks + U + K) - 1 }
    expect(checkReceiveBeforeClaim(p, own, expiring).join()).toContain('unroll needs')
  })

  test('C1/R5: subdustd’s leaf maturing with or before ours → no claim', () => {
    expect(checkReceiveBeforeClaim(p, { ...own, refundNoReceiverDelaySecs: own.claimDelaySecs }, fresh).join()).toContain('doesn')
  })

  test('an unbounded unroll (too deep) → no claim', () => {
    expect(checkReceiveBeforeClaim(p, own, { ...fresh, vhtlcDepth: p.maxChainDepth + 3 }).join()).toContain('levels deep')
  })

  test('a leaf arkd won’t spend → no claim (the attempt alone would show the preimage)', () => {
    expect(checkReceiveBeforeClaim(p, { ...own, refundDelaySecs: E - CSV_UNIT_SECS }, fresh).join()).toContain('below arkd')
  })
})

describe('buildVhtlc', () => {
  const key = () => randomBytes(32)
  const [user, peer, server] = [key(), key(), key()]
  const H = createHash('sha256').update(randomBytes(32)).digest()
  const timeouts = receiveTimeouts(p, NOW, 0)

  test('locks on HASH160 of the preimage = ripemd160(H), same as the 4-leaf claim', () => {
    const v = buildVhtlc({ sender: peer, receiver: user, server, paymentHash: H, timeouts })
    expect(v.claimScript).toContain(hex.encode(ripemd160(H)))
    expect(v.unilateralClaimScript).toContain(hex.encode(ripemd160(H)))
  })

  test('script bytes pinned — an SDK change to the VHTLC encoding fails here, not on mainnet', () => {
    const k = (s: string) => createHash('sha256').update(s).digest()
    const v = buildVhtlc({
      sender: k('sender'),
      receiver: k('receiver'),
      server: k('server'),
      paymentHash: k('preimage-hash'),
      timeouts: { refundLocktime: 1_800_139_476, claimDelaySecs: 86_016, refundDelaySecs: 110_080, refundNoReceiverDelaySecs: 110_080 },
    })
    expect(hex.encode(v.pkScript)).toBe('5120238ed5dfc3f862559d2594a9b10dbe76caae5fc33ef603dae009beea67f74ee6')
  })

  test('deterministic, and the roles matter', () => {
    const a = buildVhtlc({ sender: peer, receiver: user, server, paymentHash: H, timeouts })
    const b = buildVhtlc({ sender: peer, receiver: user, server, paymentHash: H, timeouts })
    const swapped = buildVhtlc({ sender: user, receiver: peer, server, paymentHash: H, timeouts })
    expect(hex.encode(a.pkScript)).toBe(hex.encode(b.pkScript))
    expect(hex.encode(swapped.pkScript)).not.toBe(hex.encode(a.pkScript))
  })
})

// The float renews while it can still fund a VHTLC receive — below that life a
// coin funds nothing ≥ 330 — and inside arkd's gap (a renewal outside it is
// deferred). Regtest must stay under its 2h batch life or the float renews
// every pass.
describe('float renewal threshold', () => {
  test('mainnet: above a VHTLC receive’s funding life, inside the 4.75d gap', () => {
    const p = policyFor(86_016, 'bitcoin')
    const need = receiveFundingLifeSecs(p, 21_600)
    const t = floatRenewThresholdSecs(p, 21_600, 600)
    expect(need).toBeGreaterThan(2 * (21_600 + 600)) // the 4-leaf rule alone would leave a dead zone
    expect(t).toBeGreaterThan(need)
    expect(t).toBeLessThan(410_400)
  })
  test('regtest: under the 2h batch life', () => {
    const p = policyFor(2_048, 'regtest')
    expect(floatRenewThresholdSecs(p, 600, 60)).toBeLessThan(7_200)
  })
})
