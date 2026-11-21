import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

// Direct gRPC to LND, same RPCs the Boltz fork's LndClient used, so the swap
// paths keep their exact meaning. Protos are LND v0.21.5-beta, vendored.
//
// The one thing deliberately NOT carried over: Boltz's sendPayment rejected on
// a stream error the same way as on a terminal FAILED, and its caller marked
// the swap failed. A dropped stream says nothing about the HTLC, so here a
// throw means "outcome unknown" and only a returned FAILED means failed.

const PROTO_DIR = fileURLToPath(new URL('./proto/', import.meta.url))

const loadPackage = () => {
  const def = protoLoader.loadSync(['lightning.proto', 'invoices.proto', 'router.proto'], {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  })
  return grpc.loadPackageDefinition(def) as unknown as {
    lnrpc: { Lightning: grpc.ServiceClientConstructor }
    invoicesrpc: { Invoices: grpc.ServiceClientConstructor }
    routerrpc: { Router: grpc.ServiceClientConstructor }
  }
}

export interface LndConnection {
  socket: string
  certPath: string
  macaroonPath: string
}

export class LndError extends Error {
  constructor(
    readonly method: string,
    readonly code: grpc.status | undefined,
    detail: string,
  ) {
    super(`lnd ${method}: ${detail}`)
  }

  get notFound(): boolean {
    return this.code === grpc.status.NOT_FOUND
  }
}

const toLndError = (method: string, err: unknown): LndError => {
  if (err instanceof LndError) return err
  const e = err as Partial<grpc.ServiceError> | undefined
  return new LndError(method, e?.code, e?.details || e?.message || String(err))
}

export interface HopHint {
  nodeId: string
  chanId: string
  feeBaseMsat: number
  feeProportionalMillionths: number
  cltvExpiryDelta: number
}

export interface NodeInfo {
  pubkey: string
  /** LND's own chain name: mainnet | testnet | testnet4 | signet | regtest. */
  network: string
  version: string
  blockHeight: number
  syncedToChain: boolean
}

export interface DecodedInvoice {
  destination: string
  paymentHash: string
  valueSat: number
  valueMsat: bigint
  cltvExpiry: number
  expirySecs: number
  timestamp: number
  /** Hex, empty when the invoice carries a plain description. */
  descriptionHash: string
  routeHints: HopHint[][]
}

export interface RouteQuote {
  /** Absolute height the first hop's HTLC expires at — subtract the tip for a delta. */
  totalTimeLock: number
  totalFeesMsat: bigint
}

export type InvoiceState = 'OPEN' | 'SETTLED' | 'CANCELED' | 'ACCEPTED'
export type InvoiceHtlcState = 'ACCEPTED' | 'SETTLED' | 'CANCELED'

export interface InvoiceSnapshot {
  state: InvoiceState
  paymentRequest: string
  htlcs: { state: InvoiceHtlcState; amtMsat: bigint }[]
}

export type PaymentStatus = 'UNKNOWN' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'INITIATED'
export type HtlcAttemptStatus = 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED'

export interface PaymentSnapshot {
  status: PaymentStatus
  /** Hex. Only meaningful on SUCCEEDED; LND leaves it empty or all-zero otherwise. */
  preimage: string
  feeMsat: bigint
  failureReason: string
  htlcs: { status: HtlcAttemptStatus }[]
}

/** `found: false` is LND's NOT_FOUND: it never initiated a payment for this hash. */
export type TrackResult = { found: false } | { found: true; payment: PaymentSnapshot }

export type PayResult =
  | { status: 'SUCCEEDED'; preimage: string; feeMsat: bigint }
  | { status: 'FAILED'; failureReason: string }

export interface PayOptions {
  /** Max total cltv delta the route may use (blocks). */
  cltvLimit: number
  feeLimitSat: number
  timeoutSecs?: number
  maxParts?: number
  timePref?: number
}

// Boltz's values, kept so payments route the way they did.
const PAY_TIMEOUT_SECS = 300
const PAY_MAX_PARTS = 6
const TIME_PREF = 0.9
// lncli's limit — graph-sized replies otherwise trip grpc-js's 4 MB default.
const MAX_RECEIVE_BYTES = 200 * 1024 * 1024

const hexOf = (b: unknown): string => (Buffer.isBuffer(b) ? b.toString('hex') : '')
const big = (v: unknown): bigint => BigInt((v as string | number | undefined) ?? 0)
const num = (v: unknown): number => Number((v as string | number | undefined) ?? 0)

// proto-loader messages are untyped; `any` stays inside the mappers below.
const hopHintsFrom = (hints: any[]): HopHint[][] =>
  hints.map((h) =>
    (h.hop_hints as any[]).map((hop) => ({
      nodeId: hop.node_id,
      chanId: String(hop.chan_id),
      feeBaseMsat: num(hop.fee_base_msat),
      feeProportionalMillionths: num(hop.fee_proportional_millionths),
      cltvExpiryDelta: num(hop.cltv_expiry_delta),
    })),
  )

const hopHintsTo = (hints: HopHint[][]) =>
  hints.map((hops) => ({
    hop_hints: hops.map((h) => ({
      node_id: h.nodeId,
      chan_id: h.chanId,
      fee_base_msat: h.feeBaseMsat,
      fee_proportional_millionths: h.feeProportionalMillionths,
      cltv_expiry_delta: h.cltvExpiryDelta,
    })),
  }))

const invoiceFrom = (inv: any): InvoiceSnapshot => ({
  state: inv.state,
  paymentRequest: inv.payment_request,
  htlcs: (inv.htlcs as any[]).map((h) => ({ state: h.state, amtMsat: big(h.amt_msat) })),
})

const paymentFrom = (p: any): PaymentSnapshot => ({
  status: p.status,
  preimage: p.payment_preimage ?? '',
  feeMsat: big(p.fee_msat),
  failureReason: p.failure_reason ?? '',
  htlcs: (p.htlcs as any[]).map((h) => ({ status: h.status })),
})

export class LndClient {
  private readonly lightning: grpc.Client & Record<string, any>
  private readonly invoices: grpc.Client & Record<string, any>
  private readonly router: grpc.Client & Record<string, any>

  constructor(
    conn: LndConnection,
    private readonly unaryDeadlineMs = 30_000,
  ) {
    const macaroon = readFileSync(conn.macaroonPath).toString('hex')
    const creds = grpc.credentials.combineChannelCredentials(
      grpc.credentials.createSsl(readFileSync(conn.certPath)),
      grpc.credentials.createFromMetadataGenerator((_params, cb) => {
        const md = new grpc.Metadata()
        md.add('macaroon', macaroon)
        cb(null, md)
      }),
    )
    const pkg = loadPackage()
    const opts: grpc.ChannelOptions = { 'grpc.max_receive_message_length': MAX_RECEIVE_BYTES }
    // Bun's TLS rejects an IP literal as the SNI servername (Node only warns),
    // and production dials LND by IP. LND's self-signed cert always carries
    // DNS:localhost, and the cert itself is pinned as the only trusted root,
    // so naming it that changes no trust — it only gets past the SNI check.
    if (isIP(conn.socket.slice(0, conn.socket.lastIndexOf(':')).replace(/^\[|\]$/g, ''))) {
      opts['grpc.ssl_target_name_override'] = 'localhost'
      opts['grpc.default_authority'] = 'localhost'
    }
    this.lightning = new pkg.lnrpc.Lightning(conn.socket, creds, opts) as never
    this.invoices = new pkg.invoicesrpc.Invoices(conn.socket, creds, opts) as never
    this.router = new pkg.routerrpc.Router(conn.socket, creds, opts) as never
  }

  close(): void {
    this.lightning.close()
    this.invoices.close()
    this.router.close()
  }

  // A deadline on every unary call: an LND that hangs must surface as an
  // error, because callers treat "LND did not answer" as a refusal.
  private unary<T>(client: grpc.Client & Record<string, any>, method: string, req: object): Promise<T> {
    return new Promise((resolve, reject) => {
      client[method](req, { deadline: Date.now() + this.unaryDeadlineMs }, (err: unknown, res: T) =>
        err ? reject(toLndError(method, err)) : resolve(res),
      )
    })
  }

  async getInfo(): Promise<NodeInfo> {
    const r = await this.unary<any>(this.lightning, 'GetInfo', {})
    return {
      pubkey: r.identity_pubkey,
      network: (r.chains as any[])[0]?.network ?? '',
      version: r.version,
      blockHeight: num(r.block_height),
      syncedToChain: Boolean(r.synced_to_chain),
    }
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const r = await this.unary<any>(this.lightning, 'DecodePayReq', { pay_req: bolt11 })
    return {
      destination: r.destination,
      paymentHash: r.payment_hash,
      valueSat: num(r.num_satoshis),
      valueMsat: big(r.num_msat),
      cltvExpiry: num(r.cltv_expiry),
      expirySecs: num(r.expiry),
      timestamp: num(r.timestamp),
      descriptionHash: r.description_hash ?? '',
      routeHints: hopHintsFrom(r.route_hints),
    }
  }

  /** Throws when LND finds no path — it reports that as an error, not an empty list. */
  async queryRoutes(
    destination: string,
    amtSat: number,
    opts: { cltvLimit?: number; finalCltvDelta?: number; routeHints?: HopHint[][] } = {},
  ): Promise<RouteQuote[]> {
    const r = await this.unary<any>(this.lightning, 'QueryRoutes', {
      pub_key: destination,
      amt: String(amtSat),
      use_mission_control: true,
      time_pref: TIME_PREF,
      cltv_limit: opts.cltvLimit ?? 0,
      final_cltv_delta: opts.finalCltvDelta ?? 0,
      route_hints: hopHintsTo(opts.routeHints ?? []),
    })
    return (r.routes as any[]).map((route) => ({
      totalTimeLock: num(route.total_time_lock),
      totalFeesMsat: big(route.total_fees_msat),
    }))
  }

  async addHoldInvoice(req: {
    valueSat: number
    paymentHash: string
    cltvExpiry: number
    expirySecs: number
    memo?: string
    descriptionHash?: string
  }): Promise<string> {
    const r = await this.unary<any>(this.invoices, 'AddHoldInvoice', {
      value: String(req.valueSat),
      hash: Buffer.from(req.paymentHash, 'hex'),
      cltv_expiry: String(req.cltvExpiry),
      expiry: String(req.expirySecs),
      memo: req.memo ?? '',
      description_hash: req.descriptionHash ? Buffer.from(req.descriptionHash, 'hex') : Buffer.alloc(0),
    })
    return r.payment_request
  }

  /** Throws `LndError` with `notFound` for a hash LND has no invoice for. */
  async lookupInvoice(paymentHash: string): Promise<InvoiceSnapshot> {
    return invoiceFrom(await this.unary<any>(this.lightning, 'LookupInvoice', { r_hash: Buffer.from(paymentHash, 'hex') }))
  }

  async settleHoldInvoice(preimage: string): Promise<void> {
    await this.unary(this.invoices, 'SettleInvoice', { preimage: Buffer.from(preimage, 'hex') })
  }

  async cancelHoldInvoice(paymentHash: string): Promise<void> {
    await this.unary(this.invoices, 'CancelInvoice', { payment_hash: Buffer.from(paymentHash, 'hex') })
  }

  /**
   * Streams every state change of one invoice until it is settled or canceled,
   * the stream drops, or the returned function is called. `onEnd` fires once
   * either way; nothing re-subscribes — the periodic scan is the backstop.
   */
  subscribeSingleInvoice(
    paymentHash: string,
    onUpdate: (invoice: InvoiceSnapshot) => void,
    onEnd?: (err?: LndError) => void,
  ): () => void {
    const stream: grpc.ClientReadableStream<any> = this.invoices.SubscribeSingleInvoice({
      r_hash: Buffer.from(paymentHash, 'hex'),
    })
    let ended = false
    const end = (err?: LndError) => {
      if (ended) return
      ended = true
      stream.removeAllListeners()
      stream.on('error', () => {}) // cancel() emits CANCELLED after we detach
      stream.cancel()
      onEnd?.(err)
    }
    stream.on('data', (inv: any) => {
      const snap = invoiceFrom(inv)
      onUpdate(snap)
      if (snap.state === 'SETTLED' || snap.state === 'CANCELED') end()
    })
    stream.on('error', (err) => end(toLndError('SubscribeSingleInvoice', err)))
    stream.on('end', () => end())
    return () => end()
  }

  /**
   * Pays and waits for the terminal status. A returned FAILED is final: no HTLC
   * can settle any more. A THROW is not a failure — the stream died and the
   * payment may still be in flight, so callers must look it up with
   * `trackPayment` before treating it either way.
   */
  sendPayment(bolt11: string, opts: PayOptions): Promise<PayResult> {
    return new Promise((resolve, reject) => {
      const stream: grpc.ClientReadableStream<any> = this.router.SendPaymentV2({
        payment_request: bolt11,
        cltv_limit: opts.cltvLimit,
        fee_limit_sat: String(opts.feeLimitSat),
        timeout_seconds: opts.timeoutSecs ?? PAY_TIMEOUT_SECS,
        max_parts: opts.maxParts ?? PAY_MAX_PARTS,
        time_pref: opts.timePref ?? TIME_PREF,
      })
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        stream.removeAllListeners()
        stream.on('error', () => {})
        stream.cancel()
        fn()
      }
      stream.on('data', (p: any) => {
        const snap = paymentFrom(p)
        if (snap.status === 'SUCCEEDED') {
          finish(() => resolve({ status: 'SUCCEEDED', preimage: snap.preimage, feeMsat: snap.feeMsat }))
        } else if (snap.status === 'FAILED') {
          finish(() => resolve({ status: 'FAILED', failureReason: snap.failureReason }))
        }
      })
      stream.on('error', (err) => finish(() => reject(toLndError('SendPaymentV2', err))))
      stream.on('end', () => finish(() => reject(new LndError('SendPaymentV2', undefined, 'stream ended before a terminal status'))))
    })
  }

  /**
   * One snapshot of the payment for this hash (`untilFinal = false`, the first
   * message LND sends), or its terminal status (`untilFinal = true` — blocks for
   * as long as an HTLC is in flight, so no deadline). LND's NOT_FOUND comes back
   * as `found: false`; every other error throws.
   */
  trackPayment(paymentHash: string, untilFinal = false): Promise<TrackResult> {
    return new Promise((resolve, reject) => {
      const stream: grpc.ClientReadableStream<any> = this.router.TrackPaymentV2(
        { payment_hash: Buffer.from(paymentHash, 'hex'), no_inflight_updates: untilFinal },
        untilFinal ? {} : { deadline: Date.now() + this.unaryDeadlineMs },
      )
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        stream.removeAllListeners()
        stream.on('error', () => {})
        stream.cancel()
        fn()
      }
      stream.on('data', (p: any) => finish(() => resolve({ found: true, payment: paymentFrom(p) })))
      stream.on('error', (err) => {
        const e = toLndError('TrackPaymentV2', err)
        finish(() => (e.notFound ? resolve({ found: false }) : reject(e)))
      })
      stream.on('end', () => finish(() => reject(new LndError('TrackPaymentV2', undefined, 'stream ended without a payment'))))
    })
  }
}
