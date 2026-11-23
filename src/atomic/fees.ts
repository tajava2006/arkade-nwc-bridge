// The atomic send's fee, shared by subdustd (which charges it) and the bridge
// (which previews it and caps what it will fund). One formula, one place.

/** What subdustd charges on a send of `amountSat` at `pct` percent: ceil, so 1 sat minimum. */
export const sendFeeSats = (amountSat: number, pct: number): number => (pct > 0 ? Math.ceil((amountSat * pct) / 100) : 0)

/** The most fee the bridge accepts from subdustd: 1% of `a`, never below dust. */
export const maxSendFeeSats = (a: number, dust: number): number => Math.max(dust, Math.ceil(a / 100))
