// The atomic send's fee, shared by subdustd (which charges it) and the bridge
// (which previews it and caps what it will fund). One formula, one place.

/** What subdustd charges on a send of `amountSat` at `pct` percent: ceil, so 1 sat minimum. */
export const sendFeeSats = (amountSat: number, pct: number): number => (pct > 0 ? Math.ceil((amountSat * pct) / 100) : 0)

/** The most fee the bridge accepts from subdustd: 1% of `a`, never below dust. */
export const maxSendFeeSats = (a: number, dust: number): number => Math.max(dust, Math.ceil(a / 100))

/**
 * The invoice amount whose atomic send costs exactly `totalSat` (invoice +
 * sendFeeSats) — what to pay to empty `totalSat` over Lightning — or null when
 * no amount does. The fee's ceil skips some totals (at 0.5%, every 201k + 1),
 * and the funding has no other place to put a leftover sat: change below dust
 * is refused rather than stranded.
 */
export function lnDrainInvoiceSat(totalSat: number, pct: number): number | null {
  const cost = (x: number): number => x + sendFeeSats(x, pct)
  let x = Math.floor(totalSat / (1 + pct / 100))
  while (cost(x + 1) <= totalSat) x++
  while (x > 0 && cost(x) > totalSat) x--
  return x > 0 && cost(x) === totalSat ? x : null
}
