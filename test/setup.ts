// Test preload. @noble/curves v2 ships as async ESM; @arkade-os's compiled
// CJS does `require("@noble/curves/secp256k1.js")`, which Bun rejects unless
// the module was already ESM-imported (and thus resolved) earlier in the
// process. `bun test` runs every file in one process, so whether the warming
// import wins the race against the CJS require is import-order dependent —
// adding any new module to the graph can flip it. ESM-importing it here,
// before any test file loads, resolves it once so later requires hit cache.
import '@noble/curves/secp256k1.js'
// @bitcoinerlab/descriptors-scure also CJS-requires @scure/btc-signer (async
// ESM as well) — warming only @noble/curves left this race open, which is why
// fresh worktrees kept aborting a file on their first `bun test`.
import '@scure/btc-signer'
