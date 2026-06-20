// noffer (CLINK Offers) bech32+TLV codec.
//
// Vendored from shocknet ClinkSDK's nip19Extension.ts (MIT) rather than
// depending on the whole SDK: the SDK pins nostr-tools@2.15.1 against our
// ^2.23.5 and ships only the *payer* side anyway — we just need the static
// code minted. The TLV/bech32 framing is the error-prone part worth copying
// verbatim from the spec's reference impl; the receiver loop is ours
// (clink/offers.ts). Spec: reference/CLINK/specs/clink-offers.md.
//
// We encode to mint our own code, and decode our *own stored* code on boot
// to recover the relay/pubkey baked in at mint time. (Decoding a stranger's
// noffer to pay it is the payer's job — not something the bridge does.)

import { bech32 } from '@scure/base'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'

const utf8Decoder = new TextDecoder()

const utf8Encoder = new TextEncoder()

// noffer TLV 3 pricing flag.
export enum OfferPriceType {
  Fixed = 0,
  Variable = 1,
  Spontaneous = 2,
}

export interface OfferPointer {
  pubkey: string // hex; TLV 0
  relay: string // TLV 1
  offer: string // TLV 2
  priceType: OfferPriceType // TLV 3
  price?: number // TLV 4 (sats), optional
}

type TLV = { [t: number]: Uint8Array[] }

// 32-bit big-endian, matching the reference encoder (TLV 4 is read back
// with parseInt(hex, 16) on the payer side).
function integerToUint8Array(n: number): Uint8Array {
  const a = new Uint8Array(4)
  a[0] = (n >> 24) & 0xff
  a[1] = (n >> 16) & 0xff
  a[2] = (n >> 8) & 0xff
  a[3] = n & 0xff
  return a
}

function encodeTLV(tlv: TLV): Uint8Array {
  const entries: Uint8Array[] = []
  // Reverse so lower type numbers end up last on the wire, matching the
  // reference impl's byte order (decoders read order-independently, but we
  // stay byte-identical to ClinkSDK to avoid surprises).
  Object.entries(tlv)
    .reverse()
    .forEach(([t, vs]) => {
      vs.forEach((v) => {
        const entry = new Uint8Array(v.length + 2)
        entry[0] = parseInt(t, 10)
        entry[1] = v.length
        entry.set(v, 2)
        entries.push(entry)
      })
    })
  const total = entries.reduce((n, e) => n + e.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const e of entries) {
    out.set(e, off)
    off += e.length
  }
  return out
}

type TLVMap = { [t: number]: Uint8Array[] }

function parseTLV(data: Uint8Array): TLVMap {
  const result: TLVMap = {}
  let rest = data
  while (rest.length > 0) {
    const t = rest[0]!
    const l = rest[1]!
    const v = rest.slice(2, 2 + l)
    if (v.length < l) throw new Error(`noffer: truncated TLV ${t}`)
    ;(result[t] ||= []).push(v)
    rest = rest.slice(2 + l)
  }
  return result
}

// Decode our own noffer back to its pointer. Reads only the first entry of
// each TLV type, matching the reference decoder (TLV 1 / relay is singular).
export function nofferDecode(code: string): OfferPointer {
  const { prefix, words } = bech32.decode(code as `${string}1${string}`, 5000)
  if (prefix !== 'noffer') throw new Error(`expected noffer, got ${prefix}`)
  const tlv = parseTLV(new Uint8Array(bech32.fromWords(words)))
  if (tlv[0]?.[0]?.length !== 32) throw new Error('noffer: missing/invalid pubkey (TLV 0)')
  if (!tlv[1]?.[0]) throw new Error('noffer: missing relay (TLV 1)')
  if (!tlv[2]?.[0]) throw new Error('noffer: missing offer id (TLV 2)')
  return {
    pubkey: bytesToHex(tlv[0][0]),
    relay: utf8Decoder.decode(tlv[1][0]),
    offer: utf8Decoder.decode(tlv[2][0]),
    priceType: (tlv[3]?.[0]?.[0] ?? OfferPriceType.Spontaneous) as OfferPriceType,
    price: tlv[4]?.[0] ? parseInt(bytesToHex(tlv[4][0]), 16) : undefined,
  }
}

export function nofferEncode(offer: OfferPointer): string {
  const o: TLV = {
    0: [hexToBytes(offer.pubkey)],
    1: [utf8Encoder.encode(offer.relay)],
    2: [utf8Encoder.encode(offer.offer)],
    3: [new Uint8Array([Number(offer.priceType)])],
  }
  if (offer.price) {
    o[4] = [integerToUint8Array(offer.price)]
  }
  const data = encodeTLV(o)
  // 5000 = Bech32MaxSize from the spec; noffer payloads are tiny but the
  // limit must exceed bech32's default 90-char cap.
  const words = bech32.toWords(data)
  return bech32.encode('noffer', words, 5000)
}
