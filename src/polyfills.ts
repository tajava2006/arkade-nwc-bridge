// Warm @noble/curves (async ESM) before anything can CJS-require it.
// @bitcoinerlab's compiled CJS (pulled in by the SDK's descriptor code) does
// `require("@noble/curves/secp256k1.js")`, which Bun rejects unless the
// module was already ESM-imported earlier in the process. test/setup.ts has
// carried this exact warming for the test runner; the app graph relied on
// import-order luck until an added import flipped the race and crashed the
// boot path (observed on the #07 branch). Every bridge entrypoint imports
// this file first, so warming here covers them all.
import '@noble/curves/secp256k1.js'

// The Ark SDK uses EventSource for SSE streams (settlement events, contract
// watching). Bun ships EventSource globally on recent versions, but install
// the eventsource package as a fallback so we don't depend on that.
import { EventSource as NodeEventSource } from 'eventsource'

const g = globalThis as { EventSource?: typeof EventSource }
if (!g.EventSource) {
  g.EventSource = NodeEventSource as unknown as typeof EventSource
}
