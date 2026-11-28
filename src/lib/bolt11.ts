import { decode } from 'light-bolt11-decoder'

// BOLT11 decoding, carried over verbatim from @arkade-os/boltz-swap's
// decodeInvoice when that package left the tree, so every caller keeps the
// exact same values. That includes its quirk: `expiry` is the RAW relative
// `x`-tag seconds (3600 when absent), not an absolute time —
// ln_receive.absoluteExpiry normalizes it by magnitude.

export interface DecodedInvoice {
  /** Relative expiry seconds as encoded (3600 when the invoice omits it). */
  expiry: number
  timestamp: number
  amountSats: number
  description: string
  /** BOLT11 `h`, hex; "" if none. */
  descriptionHash: string
  paymentHash: string
}

type Section = { name: string; value?: unknown }

export const decodeInvoice = (invoice: string): DecodedInvoice => {
  const decoded = decode(invoice) as unknown as { expiry?: number; sections: Section[] }
  const field = (name: string) => decoded.sections.find((s) => s.name === name)?.value
  const millisats = BigInt((field('amount') as string | undefined) ?? '0')
  return {
    expiry: decoded.expiry ?? 3600,
    timestamp: (field('timestamp') as number | undefined) ?? 0,
    amountSats: Number(millisats / 1000n),
    description: (field('description') as string | undefined) ?? '',
    descriptionHash: (field('description_hash') as string | undefined) ?? '',
    paymentHash: (field('payment_hash') as string | undefined) ?? '',
  }
}
