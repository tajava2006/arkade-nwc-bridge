import '../src/polyfills.ts'
import { hex } from '@scure/base'
import { ReceiveService } from './api/receive.ts'
import { SendService } from './api/send.ts'
import { SwapLocks } from './api/http_error.ts'
import { KeyFileError, loadKeyFile } from './ark/key.ts'
import { arkdNetworkMismatch, ArkSigner } from './ark/signer.ts'
import { checkConfigFiles, ConfigError, loadConfig, type SubdustdConfig } from './config.ts'
import { startHttp } from './http.ts'
import { LndClient } from './lnd/client.ts'
import { probeLnd } from './lnd/probe.ts'
import { createLogger } from './log.ts'
import { probeUntilAnswered } from './probe.ts'
import { PushHub } from './push.ts'
import { Scanner } from './scanner.ts'
import { FloatLock, FloatRenewer, lazyFloatManager } from './float.ts'
import { SwapStore } from './store.ts'
import { readFileSync } from 'node:fs'
import { EsploraProvider, type OnchainProvider } from '@arkade-os/sdk'
import { BitcoindOnchainProvider, BitcoindRpc } from '../src/chain/bitcoind.ts'
import { OnchainExecutor } from './onchain.ts'
import { floatRenewThresholdSecs, policyFor } from '../src/atomic/vhtlc.ts'

const path = process.argv[2]
if (!path) {
  console.error('usage: bun run subdustd/main.ts <config.json>')
  process.exit(2)
}

const refuse = (problem: string): never => {
  console.error(`subdustd config rejected:\n  - ${problem}`)
  process.exit(1)
}

let config: SubdustdConfig
let warnings: string[]
try {
  ;({ config, warnings } = loadConfig(path))
  checkConfigFiles(config)
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : `subdustd: ${String(e)}`)
  process.exit(1)
}

let key!: Uint8Array
try {
  const loaded = loadKeyFile(config.keyPath)
  key = loaded.key
  warnings.push(...loaded.warnings)
} catch (e) {
  refuse(`config.keyPath: ${e instanceof KeyFileError ? e.message : String(e)}`)
}

let lnd!: LndClient
try {
  lnd = new LndClient(config.lnd)
} catch (e) {
  refuse(`config.lnd: cannot load the TLS cert: ${(e as Error).message}`)
}

let store!: SwapStore
try {
  store = SwapStore.open(config.dbPath)
} catch (e) {
  refuse(`config.dbPath: ${(e as Error).message}`)
}

const log = createLogger(config.logLevel)
for (const w of warnings) log.warn(`config: ${w}`)
log.info(
  `subdustd ${config.network} arkd=${config.arkdUrl} lnd=${config.lnd.socket} db=${config.dbPath} ` +
    `knobs=${JSON.stringify(config.subdust)}`,
)

const signer = new ArkSigner(key, config.arkdUrl)
log.info(`ark key ${hex.encode(await signer.xOnlyPublicKey())}`)
const locks = new SwapLocks()
const push = new PushHub((id) => store.get(id)?.state)
const emit = (swapId: string, state: string) => {
  log.debug(`swap ${swapId} → ${state}`)
  push.publish(swapId, state)
}
const send = new SendService({ store, signer, lnd, knobs: config.subdust, log, locks, emit })
const floatLock = new FloatLock()
const receive = new ReceiveService({ store, signer, lnd, knobs: config.subdust, log, locks, emit, floatLock })
const server = startHttp(config, log, { send, receive, push })
// Renew a float coin while it can still fund a VHTLC receive with room to
// spare (floatRenewThresholdSecs): under that life it funds nothing ≥ 330, and
// a float whose coins share a batch would refuse every such receive at once.
// Needs arkd's exit delay, so it's read per pass — arkd may be down at boot.
const floatThresholdSecs = async (): Promise<number> => {
  const info = await signer.getInfo()
  return floatRenewThresholdSecs(
    policyFor(Number(info.unilateralExitDelay), info.network),
    config.subdust.receiveWindowSecs,
    config.subdust.payMarginSecs,
  )
}
const float = new FloatRenewer({
  manager: lazyFloatManager({
    identity: signer.identity,
    operator: signer.ark,
    indexer: signer.indexer,
    expectedAddress: async () => (await signer.receiveAddress()).encode(),
    chainHeight: async () => (await lnd.getInfo()).blockHeight,
  }),
  lock: floatLock,
  thresholdSecs: floatThresholdSecs,
  log,
})
// The VHTLC's on-chain paths (F32_VHTLC_PLAN §7): without a chain backend an
// unrolled VHTLC is not enforced — the script still guards it, nobody acts.
let onchain: OnchainExecutor | undefined
if (config.chain) {
  const c = config.chain
  const provider: OnchainProvider =
    c.kind === 'bitcoind'
      ? new BitcoindOnchainProvider(new BitcoindRpc({ url: c.url, user: c.user, password: readFileSync(c.passwordPath, 'utf8').trim() }))
      : new EsploraProvider(c.url)
  onchain = new OnchainExecutor({ store, signer, provider, network: config.network, lnd, receive, locks, log, emit })
  void onchain
    .fuel()
    .then(async (w) => {
      log.info(`onchain: ${c.kind} ${c.url} — fuel address ${w.address} (pays unroll CPFPs; on-chain takes land here)`)
      const coins = await provider.getCoins(w.address)
      const sats = coins.reduce((n, x) => n + x.value, 0)
      if (sats === 0) log.warn('onchain: the fuel address is empty — an unroll we must push can’t pay its CPFP until it is funded')
      else log.info(`onchain: fuel ${sats} sats in ${coins.length} coin(s)`)
    })
    .catch((e: Error) => log.warn(`onchain: fuel check failed: ${e.message}`))
} else {
  log.warn('onchain: no chain backend (config.chain) — an unrolled VHTLC would NOT be enforced on chain')
}
const scanner = new Scanner({ store, send, receive, medianTimePast: () => lnd.medianTimePast(), float, onchain, log })
scanner.start()

let stopping = false
const shutdown = (reason: string, code = 0) => {
  if (stopping) return
  stopping = true
  log.info(`${reason}: shutting down`)
  scanner.stop()
  onchain?.stop()
  server.stop(true)
  receive.close()
  lnd.close()
  store.close()
  process.exit(code)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

const fatal = (reason: string) => {
  log.error(reason)
  shutdown('dependency on the wrong network', 1)
}
const probeOpts = { stopped: () => stopping }

void probeLnd(lnd, config.network, log, fatal, probeOpts)
void probeUntilAnswered(
  {
    name: 'arkd',
    ask: () => signer.getInfo(true),
    mismatch: (info) => arkdNetworkMismatch(config.network, info),
    describe: (info) =>
      `arkd on ${info.network}, signer ${info.signerPubkey}, exit delay ${info.unilateralExitDelay}, dust ${info.dust}`,
  },
  log,
  fatal,
  probeOpts,
).then(async (info) => {
  if (info) log.info(`receive/top-up address ${(await signer.receiveAddress()).encode()}`)
})
