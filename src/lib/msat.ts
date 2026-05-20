// NWC uses millisatoshis end-to-end. The Ark wallet only knows sats. Boltz
// also operates in sats. We round at the bridge boundary; non-multiple-of-1000
// amounts coming in from clients are flagged so the caller can reject with
// NIP-47 OTHER rather than silently truncate.

export function satsToMsats(sats: number): number {
  return sats * 1000
}

export interface MsatsToSatsResult {
  sats: number
  exact: boolean
}

export function msatsToSats(msats: number): MsatsToSatsResult {
  return {
    sats: Math.floor(msats / 1000),
    exact: msats % 1000 === 0,
  }
}
