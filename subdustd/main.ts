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
import { SwapStore } from './store.ts'

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
// The push channel (SM-27) hooks in here; until then transitions are only logged.
const emit = (swapId: string, state: string) => log.debug(`swap ${swapId} → ${state}`)
const send = new SendService({ store, signer, lnd, knobs: config.subdust, log, locks, emit })
const receive = new ReceiveService({ store, signer, lnd, knobs: config.subdust, log, locks, emit })
const server = startHttp(config, log, { send, receive })

let stopping = false
const shutdown = (reason: string, code = 0) => {
  if (stopping) return
  stopping = true
  log.info(`${reason}: shutting down`)
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
