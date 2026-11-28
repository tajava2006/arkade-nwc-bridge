import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import {
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import { SqliteAtomicSwapRepository } from '../../src/atomic'
import { reconcileClinkAcks, startOfferService, type OfferService } from '../../src/clink/offers'
import { CLINK_OFFER_ID } from '../../src/defaults'
import { openDatabase } from '../../src/db'
import { reconcileAtomicReceives } from '../../src/ln_receive'
import { decryptContent, encryptContent } from '../../src/nostr/crypto'
import type { OutboxWatcher } from '../../src/nostr/outbox'

// CLINK noffer receives (SM-45) on the regtest-solver harness: a payer's
// kind-21001 request with a NIP-57 zap → our invoice from subdustd carrying
// the zap's description hash → the payer pays → the reconcile passes claim,
// then publish the CLINK payment receipt (preimage) and the 9735 zap receipt
// that commits to the invoice. Relay: the harness's strfry.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/clink_receive.test.ts

const SUBDUSTD_URL = process.env.SUBDUSTD_URL
const RELAY = process.env.REGTEST_NOSTR_RELAY ?? 'ws://localhost:7777'
const ARKD = process.env.REGTEST_ARKD_URL ?? 'http://localhost:7070'
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'

const sh = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const peer = (...args: string[]): any => JSON.parse(sh('exec', 'lnd-peer', 'lncli', '--network=regtest', ...args))
const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const payers: ChildProcess[] = []
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 120_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined) return v
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}

describe.skipIf(!SUBDUSTD_URL)('CLINK receive on regtest', () => {
  const serviceSk = generateSecretKey()
  const servicePub = getPublicKey(serviceSk)
  const payerSk = generateSecretKey()
  const payerPub = getPublicKey(payerSk)
  const pool = new SimplePool()
  const seen: NostrEvent[] = []
  let wallet: Wallet
  let db: Database
  let offers: OfferService
  let closeSub: { close: () => void } | undefined

  beforeAll(async () => {
    wallet = await Wallet.create({
      identity: SingleKey.fromPrivateKey(serviceSk),
      operatorProvider: new RestOperatorProvider(ARKD),
      indexerProvider: new RestIndexerProvider(ARKD),
      onchainProvider: new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 }),
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'bridge-clink-')), 'bridge.sqlite'))
    const outbox = { getOutboxRelays: () => [RELAY] } as unknown as OutboxWatcher
    offers = startOfferService({ pool, db, secretKey: serviceSk, outbox, wallet, subdustdUrl: SUBDUSTD_URL, arkServerUrl: ARKD })
    // Everything our service or the payer publishes that concerns the payer.
    closeSub = pool.subscribeMany([RELAY], { kinds: [21001, 9735], '#p': [payerPub, servicePub] }, { onevent: (e) => void seen.push(e) })
    await Bun.sleep(1500) // let both subscriptions land on the relay
  }, 120_000)

  afterAll(async () => {
    for (const p of payers) p.kill()
    closeSub?.close()
    offers?.stop()
    pool.close([RELAY])
    await wallet?.dispose()
  })

  test('a 1000-sat zap through the noffer: zap-bound invoice, then both receipts after the claim', async () => {
    expect(offers.snapshot().relay).toBe(RELAY.endsWith('/') ? RELAY : `${RELAY}/`)
    const zap = JSON.stringify(
      finalizeEvent(
        {
          kind: 9734,
          created_at: Math.floor(Date.now() / 1000),
          content: 'gm',
          tags: [
            ['p', servicePub],
            ['relays', RELAY],
            ['amount', '1000000'],
          ],
        },
        payerSk,
      ),
    )
    const request = finalizeEvent(
      {
        kind: 21001,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', servicePub],
          ['clink_version', '1'],
        ],
        content: encryptContent('nip44_v2', payerSk, servicePub, JSON.stringify({ offer: CLINK_OFFER_ID, amount_sats: 1000, zap })),
      },
      payerSk,
    )
    await Promise.allSettled(pool.publish([RELAY], request))

    // The service's answer: {bolt11}, the invoice committing to sha256(zap).
    const reply = await waitFor('the offer reply', () =>
      seen.find((e) => e.kind === 21001 && e.pubkey === servicePub && e.tags.some((t) => t[0] === 'e' && t[1] === request.id)),
    )
    const { bolt11 } = JSON.parse(decryptContent('nip44_v2', payerSk, servicePub, reply.content)) as { bolt11: string }
    const decoded = peer('decodepayreq', bolt11)
    expect(decoded).toMatchObject({ num_satoshis: '1000', description_hash: sha256(zap) })
    seen.length = 0

    payers.push(spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' }))

    // The bridge's reconcile tick: claim + settle first, then the ack funnel.
    const t0 = Date.now()
    await waitFor(
      'the receive to settle',
      async () => {
        await reconcileAtomicReceives({ wallet, subdustdUrl: SUBDUSTD_URL!, arkServerUrl: ARKD, db })
        return new SqliteAtomicSwapRepository(db).getByPaymentHash(decoded.payment_hash)?.state === 'settled' ? true : undefined
      },
      240_000,
    )
    console.log(`clink regtest: settled after ${Math.round((Date.now() - t0) / 1000)}s`)
    const ackDeps = { pool, db, secretKey: serviceSk }
    await reconcileClinkAcks(ackDeps)
    const receipt = await waitFor(
      'the CLINK payment receipt',
      () => seen.find((e) => e.kind === 21001 && e.pubkey === servicePub && e.tags.some((t) => t[0] === 'e' && t[1] === request.id)),
      30_000,
    )
    const body = JSON.parse(decryptContent('nip44_v2', payerSk, servicePub, receipt.content)) as { res: string; preimage: string }
    expect(body.res).toBe('ok')
    expect(sha256(Buffer.from(body.preimage, 'hex'))).toBe(decoded.payment_hash)

    // NIP-57 Appendix E: the 9735 carries the invoice and the zap request it commits to.
    const zapReceipt = await waitFor('the 9735 zap receipt', () => seen.find((e) => e.kind === 9735), 30_000)
    expect(zapReceipt.pubkey).toBe(servicePub)
    expect(zapReceipt.tags.find((t) => t[0] === 'bolt11')?.[1]).toBe(bolt11)
    expect(zapReceipt.tags.find((t) => t[0] === 'description')?.[1]).toBe(zap)
    expect(zapReceipt.tags.find((t) => t[0] === 'preimage')?.[1]).toBe(body.preimage)
    // The pending row is the dedup: a second pass publishes nothing more.
    const count = seen.length
    await reconcileClinkAcks(ackDeps)
    await Bun.sleep(1000)
    expect(seen.length).toBe(count)
  }, 300_000)
})
