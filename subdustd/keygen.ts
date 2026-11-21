import '../src/polyfills.ts'
import { hex } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { generateKeyFile, KeyFileError } from './ark/key.ts'

// One-time setup: `bun run subdustd:keygen <path>`. Back the file up before
// funding the address subdustd logs at boot.
const path = process.argv[2]
if (!path) {
  console.error('usage: bun run subdustd:keygen <key-file>')
  process.exit(2)
}
try {
  const key = generateKeyFile(path)
  const xonly = secp256k1.getPublicKey(key, true).subarray(1)
  console.log(`wrote ${path} (mode 600)\nx-only pubkey: ${hex.encode(xonly)}\nback this file up — it is the only copy of subdustd's float key`)
} catch (e) {
  console.error(e instanceof KeyFileError ? e.message : String(e))
  process.exit(1)
}
