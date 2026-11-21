import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lnPaymentIsDead } from '../../subdustd/cancel_gate.ts'
import { LndClient, LndError, type InvoiceSnapshot } from '../../subdustd/lnd/client.ts'

// subdustd's LND client against a real regtest LND (the one a solver/subdustd
// would own) with a channel to a peer LND. Run against the arkade-regtest stack:
//
//   SUBDUSTD_LND_CERT=… SUBDUSTD_LND_MACAROON=… bun test test/regtest
//
// The macaroon should be the least-privilege one subdustd ships with:
//   lncli bakemacaroon invoices:read invoices:write offchain:read offchain:write info:read
// SUBDUSTD_LND_PEER_CERT (optional) = the peer's tls.cert, for the pinning check.

const CERT = process.env.SUBDUSTD_LND_CERT
const MACAROON = process.env.SUBDUSTD_LND_MACAROON
const SOCKET = process.env.SUBDUSTD_LND_SOCKET ?? '127.0.0.1:10009'
const PEER = process.env.SUBDUSTD_LND_PEER_CONTAINER ?? 'lnd-peer'
const PEER_CERT = process.env.SUBDUSTD_LND_PEER_CERT

const peer = (...args: string[]): any =>
  JSON.parse(execFileSync('docker', ['exec', PEER, 'lncli', '--network=regtest', ...args], { encoding: 'utf8' }))

const sha256 = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex')
const newSecret = () => {
  const preimage = randomBytes(32).toString('hex')
  return { preimage, hash: sha256(preimage) }
}

const waitFor = async (what: string, fn: () => boolean | Promise<boolean>, timeoutMs = 30_000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await fn()) return
    await Bun.sleep(300)
  }
  throw new Error(`timeout waiting for ${what}`)
}

const payers: ChildProcess[] = []
const peerPays = (bolt11: string) => {
  const p = spawn('docker', ['exec', PEER, 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' })
  payers.push(p)
  return p
}
const peerPaymentStatus = (hash: string): string | undefined =>
  peer('listpayments', '--include_incomplete', '--max_payments', '200').payments.find((p: any) => p.payment_hash === hash)?.status

describe.skipIf(!CERT || !MACAROON)('subdustd LndClient on regtest', () => {
  let lnd: LndClient
  let peerPubkey: string

  beforeAll(() => {
    lnd = new LndClient({ socket: SOCKET, certPath: CERT!, macaroonPath: MACAROON! })
    peerPubkey = peer('getinfo').identity_pubkey
  })
  afterAll(() => {
    for (const p of payers) p.kill()
    lnd?.close()
  })

  test('getInfo', async () => {
    const info = await lnd.getInfo()
    expect(info.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
    expect(info.blockHeight).toBeGreaterThan(0)
    expect(info.version).toStartWith('0.21.')
  })

  test('decodeInvoice reads amount, hash, destination and final cltv', async () => {
    const inv = peer('addinvoice', '--amt', '21', '--expiry', '600')
    const d = await lnd.decodeInvoice(inv.payment_request)
    expect(d.valueSat).toBe(21)
    expect(d.valueMsat).toBe(21_000n)
    expect(d.paymentHash).toBe(inv.r_hash)
    expect(d.destination).toBe(peerPubkey)
    expect(d.cltvExpiry).toBeGreaterThan(0)
    expect(d.expirySecs).toBe(600)
  })

  test('queryRoutes returns an absolute timelock above the tip; no path throws', async () => {
    const [info, routes] = await Promise.all([lnd.getInfo(), lnd.queryRoutes(peerPubkey, 21, { finalCltvDelta: 80 })])
    expect(routes.length).toBeGreaterThan(0)
    expect(routes[0]!.totalTimeLock).toBeGreaterThanOrEqual(info.blockHeight + 80)
    const nobody = '02' + 'ab'.repeat(32)
    // .catch, not expect().rejects: bun's matcher starves the gRPC socket until the deadline.
    expect(await lnd.queryRoutes(nobody, 21).catch((e) => e)).toBeInstanceOf(LndError)
  })

  test('hold invoice: accepted → lookup → settle, with the requested final cltv and description hash', async () => {
    const { preimage, hash } = newSecret()
    const descriptionHash = sha256('ab'.repeat(16))
    const bolt11 = await lnd.addHoldInvoice({
      valueSat: 21,
      paymentHash: hash,
      cltvExpiry: 54,
      expirySecs: 600,
      memo: 'subdust-atomic-receive 21',
      descriptionHash,
    })
    const decoded = await lnd.decodeInvoice(bolt11)
    expect(decoded.cltvExpiry).toBe(54)
    expect(decoded.descriptionHash).toBe(descriptionHash)

    const states: InvoiceSnapshot['state'][] = []
    let ended = false
    lnd.subscribeSingleInvoice(hash, (inv) => states.push(inv.state), () => (ended = true))
    peerPays(bolt11)
    await waitFor('ACCEPTED on the subscription', () => states.includes('ACCEPTED'))

    const held = await lnd.lookupInvoice(hash)
    expect(held.state).toBe('ACCEPTED')
    expect(held.htlcs.filter((h) => h.state === 'ACCEPTED').map((h) => h.amtMsat)).toEqual([21_000n])

    await lnd.settleHoldInvoice(preimage)
    await waitFor('SETTLED + stream end', () => states.includes('SETTLED') && ended)
    await waitFor('the payer to see SUCCEEDED', () => peerPaymentStatus(hash) === 'SUCCEEDED')
  }, 60_000)

  test('hold invoice: accepted → cancel refunds the payer', async () => {
    const { hash } = newSecret()
    const bolt11 = await lnd.addHoldInvoice({ valueSat: 21, paymentHash: hash, cltvExpiry: 54, expirySecs: 600 })
    const states: InvoiceSnapshot['state'][] = []
    lnd.subscribeSingleInvoice(hash, (inv) => states.push(inv.state))
    peerPays(bolt11)
    await waitFor('ACCEPTED', () => states.includes('ACCEPTED'))
    await lnd.cancelHoldInvoice(hash)
    await waitFor('CANCELED', () => states.includes('CANCELED'))
    expect((await lnd.lookupInvoice(hash)).state).toBe('CANCELED')
    await waitFor('the payer to see FAILED', () => peerPaymentStatus(hash) === 'FAILED')
  }, 60_000)

  test('subscription can be dropped by the caller before anything happens', async () => {
    const { hash } = newSecret()
    await lnd.addHoldInvoice({ valueSat: 21, paymentHash: hash, cltvExpiry: 54, expirySecs: 600 })
    let endedWith: LndError | undefined | 'not yet' = 'not yet'
    const stop = lnd.subscribeSingleInvoice(hash, () => {}, (err) => (endedWith = err))
    stop()
    expect(endedWith).toBeUndefined()
    await lnd.cancelHoldInvoice(hash)
  })

  test('lookupInvoice of an unknown hash throws notFound', async () => {
    const err = await lnd.lookupInvoice(newSecret().hash).catch((e) => e)
    expect(err).toBeInstanceOf(LndError)
    expect((err as LndError).notFound).toBe(true)
  })

  test('sendPayment succeeds with the preimage; the gate then refuses (we paid — claim, not cancel)', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const res = await lnd.sendPayment(inv.payment_request, { cltvLimit: 500, feeLimitSat: 121 })
    expect(res.status).toBe('SUCCEEDED')
    if (res.status !== 'SUCCEEDED') return
    expect(sha256(res.preimage)).toBe(inv.r_hash)

    const tracked = await lnd.trackPayment(inv.r_hash)
    expect(tracked.found && tracked.payment.status).toBe('SUCCEEDED')
    expect(await lnPaymentIsDead(lnd, inv.r_hash)).toEqual({ dead: false, reason: 'payment is SUCCEEDED' })
  }, 60_000)

  test('a cltv budget below the payee final cltv is refused up front: a throw, and no payment exists', async () => {
    // Why a throw must mean "look it up", never "failed": here it happens to be
    // safe (nothing was sent), but the same throw also comes from a dropped stream.
    const inv = peer('addinvoice', '--amt', '21')
    const err = await lnd.sendPayment(inv.payment_request, { cltvLimit: 10, feeLimitSat: 121 }).catch((e) => e)
    expect(err).toBeInstanceOf(LndError)
    expect((err as LndError).message).toContain('cltv limit 10 should be greater than')
    expect(await lnd.trackPayment(inv.r_hash)).toEqual({ found: false })
    expect((await lnPaymentIsDead(lnd, inv.r_hash)).dead).toBe(true)
  }, 60_000)

  test('an unpayable amount fails terminally (FAILED, not a throw) and the gate allows', async () => {
    const inv = peer('addinvoice', '--amt', '5000000')
    const res = await lnd.sendPayment(inv.payment_request, { cltvLimit: 500, feeLimitSat: 121 })
    expect(res.status).toBe('FAILED')
    expect(res.status === 'FAILED' && res.failureReason).toMatch(/^FAILURE_REASON_(NO_ROUTE|INSUFFICIENT_BALANCE)$/)
    expect(await lnPaymentIsDead(lnd, inv.r_hash)).toEqual({ dead: true, reason: 'payment terminally failed' })
  }, 60_000)

  test('a live HTLC: snapshot says IN_FLIGHT and the gate refuses; payee cancel → FAILED → gate allows', async () => {
    const { hash } = newSecret()
    const bolt11 = peer('addholdinvoice', hash, '--amt', '21').payment_request
    const paying = lnd.sendPayment(bolt11, { cltvLimit: 500, feeLimitSat: 121 })
    await waitFor('the peer to hold our HTLC', () => peer('lookupinvoice', hash).state === 'ACCEPTED')

    const snap = await lnd.trackPayment(hash)
    expect(snap.found && snap.payment.status).toBe('IN_FLIGHT')
    expect(snap.found && snap.payment.htlcs.some((h) => h.status === 'IN_FLIGHT')).toBe(true)
    expect(await lnPaymentIsDead(lnd, hash)).toEqual({ dead: false, reason: 'payment is IN_FLIGHT' })

    peer('cancelinvoice', hash)
    expect(await paying).toEqual({ status: 'FAILED', failureReason: 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS' })
    expect(await lnPaymentIsDead(lnd, hash)).toEqual({ dead: true, reason: 'payment terminally failed' })
  }, 60_000)

  test('a live HTLC that the payee settles resolves SUCCEEDED; untilFinal tracking returns the terminal status', async () => {
    const { preimage, hash } = newSecret()
    const bolt11 = peer('addholdinvoice', hash, '--amt', '21').payment_request
    const paying = lnd.sendPayment(bolt11, { cltvLimit: 500, feeLimitSat: 121 })
    await waitFor('the peer to hold our HTLC', () => peer('lookupinvoice', hash).state === 'ACCEPTED')
    const final = lnd.trackPayment(hash, true)
    peer('settleinvoice', preimage)
    expect(await paying).toMatchObject({ status: 'SUCCEEDED', preimage })
    const tracked = await final
    expect(tracked.found && tracked.payment.status).toBe('SUCCEEDED')
    expect(tracked.found && tracked.payment.preimage).toBe(preimage)
  }, 60_000)

  test('an unknown hash: trackPayment says not found and the gate allows', async () => {
    const { hash } = newSecret()
    expect(await lnd.trackPayment(hash)).toEqual({ found: false })
    expect(await lnPaymentIsDead(lnd, hash)).toEqual({ dead: true, reason: 'no LN payment was ever initiated' })
  })

  test('the least-privilege macaroon cannot touch on-chain funds', async () => {
    const client = lnd as unknown as { unary: (c: unknown, m: string, r: object) => Promise<unknown>; lightning: unknown }
    const err = await client.unary(client.lightning, 'WalletBalance', {}).catch((e) => e)
    expect(err).toBeInstanceOf(LndError)
    expect((err as LndError).message).toContain('permission denied')
  })

  test.skipIf(!PEER_CERT)('a different cert is refused even with the localhost name override', async () => {
    const wrong = new LndClient({ socket: SOCKET, certPath: PEER_CERT!, macaroonPath: MACAROON! }, 5_000)
    const err = await wrong.getInfo().catch((e) => e)
    wrong.close()
    expect(err).toBeInstanceOf(LndError)
    expect((err as LndError).code).toBe(14)
  }, 15_000)

  const bootWith = async (network: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'subdustd-net-'))
    writeFileSync(join(dir, 'key'), `${'11'.repeat(32)}\n`, { mode: 0o600 })
    const port = (() => {
      const s = Bun.serve({ port: 0, fetch: () => new Response() })
      const p = s.port
      s.stop(true)
      return p
    })()
    writeFileSync(
      join(dir, 'c.json'),
      JSON.stringify({
        network,
        arkdUrl: 'http://127.0.0.1:7070',
        lnd: { socket: SOCKET, certPath: CERT, macaroonPath: MACAROON },
        keyPath: join(dir, 'key'),
        dbPath: join(dir, 'db'),
        http: { port },
      }),
    )
    return Bun.spawn(['bun', 'run', 'subdustd/main.ts', join(dir, 'c.json')], { stdout: 'pipe', stderr: 'pipe' })
  }

  test('boot against the wrong chain exits 1; the right chain logs the node', async () => {
    const wrong = await bootWith('bitcoin')
    expect(await wrong.exited).toBe(1)
    // LND and arkd are probed in parallel; whichever answers first refuses.
    expect(await new Response(wrong.stderr).text()).toMatch(/(LND|arkd) is on regtest but config\.network is bitcoin/)

    const right = await bootWith('regtest')
    const out: string[] = []
    const reader = right.stdout.getReader()
    await waitFor('the lnd line', async () => {
      const { value } = await reader.read()
      if (value) out.push(new TextDecoder().decode(value))
      return out.join('').includes('on regtest, height')
    })
    right.kill('SIGTERM')
    expect(await right.exited).toBe(0)
  }, 30_000)
})
