// Bitcoin Core output-descriptor checksum (doc/descriptors.md). Core's
// importdescriptors refuses a descriptor without its 8-char checksum, so
// show-btc-key prints `tr(WIF)#checksum` ready to paste instead of making
// the user round-trip through getdescriptorinfo first.

const INPUT_CHARSET =
  '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ '
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn]

function polymod(symbols: number[]): bigint {
  let chk = 1n
  for (const value of symbols) {
    const top = chk >> 35n
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value)
    for (let i = 0n; i < 5n; i++) {
      if ((top >> i) & 1n) chk ^= GENERATOR[Number(i)]!
    }
  }
  return chk
}

/** the low-5-bit / group-of-3 expansion from Core's descriptor.cpp DescriptorChecksum */
function expand(s: string): number[] {
  const symbols: number[] = []
  let groups: number[] = []
  for (const c of s) {
    const v = INPUT_CHARSET.indexOf(c)
    if (v < 0) throw new Error(`descriptor contains invalid character ${JSON.stringify(c)}`)
    symbols.push(v & 31)
    groups.push(v >> 5)
    if (groups.length === 3) {
      symbols.push(groups[0]! * 9 + groups[1]! * 3 + groups[2]!)
      groups = []
    }
  }
  if (groups.length === 1) symbols.push(groups[0]!)
  else if (groups.length === 2) symbols.push(groups[0]! * 3 + groups[1]!)
  return symbols
}

export function descriptorChecksum(descriptor: string): string {
  const symbols = expand(descriptor).concat([0, 0, 0, 0, 0, 0, 0, 0])
  const chk = polymod(symbols) ^ 1n
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += CHECKSUM_CHARSET[Number((chk >> (5n * BigInt(7 - i))) & 31n)]!
  }
  return out
}

export function withChecksum(descriptor: string): string {
  return `${descriptor}#${descriptorChecksum(descriptor)}`
}
