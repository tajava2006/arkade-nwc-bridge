// Spike #01 (EXIT_PLAN.md §5) — is `POST {esplora}/txs/package` real?
//
// The whole unilateral-exit feature hangs on 1P1C package relay: every
// pre-signed Ark tree/ark tx is zero-fee, so it can NEVER enter a mempool
// alone — it must be submitted together with its CPFP child through
// bitcoind's `submitpackage` RPC. The SDK's EsploraProvider does that via
// `POST {base}/txs/package` (ts-sdk providers/onchain.ts). If no reachable
// esplora exposes that endpoint, the exit tab is dead on arrival — hence
// this probe runs before any vault/engine code is written.
//
// Probe mode (default, mainnet-safe — sends only invalid payloads that
// cannot be accepted): for each candidate base URL,
//   1. GET  /blocks/tip/height        — liveness
//   2. POST /txs/package  []          — endpoint existence: a 404/405 means
//      no such route; a 400 quoting a submitpackage RPC error proves the
//      route exists AND is wired straight to bitcoind
//   3. POST /txs/package  ["00","00"] — decode path: expect RPC -22
//      (TX decode failed), confirming payloads reach bitcoind's parser
//
// Live mode (regtest drill, EXIT_PLAN.md #15):
//   bun test/spike/package_broadcast.spike.ts --live <base> <parentHex> <childHex>
// submits a real 1P1C package (zero-fee v3 parent + CPFP child) and prints
// the raw response. Never point --live at mainnet with funds you care
// about; it exists to be run against the arkade-regtest mempool
// (http://localhost:3000/api).
//
// Not a bun:test file on purpose — it's a report generator, and the default
// `bun test` glob must never hit the network.

type Verdict = 'SUPPORTED' | 'MISSING' | 'UNREACHABLE' | 'AMBIGUOUS'

interface ProbeResult {
  base: string
  tipHeight: string | null
  emptyArray: { status: number; body: string } | null
  garbageTxs: { status: number; body: string } | null
  verdict: Verdict
  notes: string[]
}

const CANDIDATES = [
  // Third-party first: in the adversarial scenario this feature exists for
  // (our ASP dead or hostile), infrastructure independent of the Ark
  // ecosystem is worth more than the SDK default.
  'https://mempool.space/api',
  // SDK default for mainnet (Ark Labs operated) — fine as fallback.
  'https://mempool.arkade.sh/api',
]

const TIMEOUT_MS = 10_000

async function post(base: string, body: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/txs/package`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return { status: res.status, body: (await res.text()).slice(0, 300) }
}

// A body mentioning submitpackage (or bitcoind's -8/-22 RPC codes) proves
// the route is a live proxy to the RPC, not just a generic error page.
function looksLikeSubmitpackageProxy(r: { status: number; body: string }): boolean {
  return r.status === 400 && /submitpackage|"code":-(8|22)|deserialize|decode/i.test(r.body)
}

async function probe(base: string): Promise<ProbeResult> {
  const result: ProbeResult = {
    base,
    tipHeight: null,
    emptyArray: null,
    garbageTxs: null,
    verdict: 'UNREACHABLE',
    notes: [],
  }

  try {
    const tip = await fetch(`${base}/blocks/tip/height`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    result.tipHeight = (await tip.text()).slice(0, 20)
  } catch (err) {
    result.notes.push(`liveness failed: ${err instanceof Error ? err.message : err}`)
    return result
  }

  try {
    result.emptyArray = await post(base, [])
    result.garbageTxs = await post(base, ['00', '00'])
  } catch (err) {
    result.notes.push(`package POST failed: ${err instanceof Error ? err.message : err}`)
    return result
  }

  const missing = [result.emptyArray, result.garbageTxs].some(
    (r) => r !== null && (r.status === 404 || r.status === 405),
  )
  if (missing) {
    result.verdict = 'MISSING'
    return result
  }

  const proxied =
    looksLikeSubmitpackageProxy(result.emptyArray) || looksLikeSubmitpackageProxy(result.garbageTxs)
  result.verdict = proxied ? 'SUPPORTED' : 'AMBIGUOUS'
  if (!proxied) {
    result.notes.push('route exists but responses do not look like submitpackage relay — inspect')
  }
  return result
}

async function live(base: string, parentHex: string, childHex: string): Promise<void> {
  console.log(`LIVE 1P1C submit → ${base}/txs/package`)
  const res = await post(base, [parentHex, childHex])
  console.log(`HTTP ${res.status}`)
  console.log(res.body)
  process.exit(res.status === 200 ? 0 : 1)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--live') {
    const [, base, parentHex, childHex] = args
    if (!base || !parentHex || !childHex) {
      console.error('usage: --live <esploraBase> <parentHex> <childHex>')
      process.exit(2)
    }
    await live(base, parentHex, childHex)
    return
  }

  const results = await Promise.all(CANDIDATES.map(probe))

  console.log(`package-broadcast probe — ${new Date().toISOString()}\n`)
  for (const r of results) {
    console.log(`${r.verdict.padEnd(11)} ${r.base}`)
    console.log(`  tip height : ${r.tipHeight ?? 'n/a'}`)
    if (r.emptyArray) {
      console.log(`  POST []    : HTTP ${r.emptyArray.status} ${r.emptyArray.body}`)
    }
    if (r.garbageTxs) {
      console.log(`  POST 00,00 : HTTP ${r.garbageTxs.status} ${r.garbageTxs.body}`)
    }
    for (const n of r.notes) console.log(`  note       : ${n}`)
    console.log()
  }

  const supported = results.filter((r) => r.verdict === 'SUPPORTED')
  console.log(
    supported.length > 0
      ? `verdict: ${supported.length}/${results.length} candidates relay submitpackage — exit path viable`
      : 'verdict: NO candidate supports /txs/package — exit path blocked, need bitcoind fallback',
  )
  process.exit(supported.length > 0 ? 0 : 1)
}

main()
