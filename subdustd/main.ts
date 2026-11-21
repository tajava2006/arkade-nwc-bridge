import { checkConfigFiles, ConfigError, loadConfig, type SubdustdConfig } from './config.ts'
import { startHttp } from './http.ts'
import { LndClient } from './lnd/client.ts'
import { probeLnd } from './lnd/probe.ts'
import { createLogger } from './log.ts'

const path = process.argv[2]
if (!path) {
  console.error('usage: bun run subdustd/main.ts <config.json>')
  process.exit(2)
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

const log = createLogger(config.logLevel)
for (const w of warnings) log.warn(`config: ${w}`)
log.info(
  `subdustd ${config.network} arkd=${config.arkdUrl} lnd=${config.lnd.socket} db=${config.dbPath} ` +
    `knobs=${JSON.stringify(config.subdust)}`,
)

let lnd: LndClient
try {
  lnd = new LndClient(config.lnd)
} catch (e) {
  console.error(`subdustd config rejected:\n  - config.lnd: cannot load the TLS cert: ${(e as Error).message}`)
  process.exit(1)
}
const server = startHttp(config, log)

let stopping = false
const shutdown = (reason: string, code = 0) => {
  if (stopping) return
  stopping = true
  log.info(`${reason}: shutting down`)
  server.stop(true)
  lnd.close()
  process.exit(code)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

void probeLnd(lnd, config.network, log, (reason) => {
  log.error(reason)
  shutdown('lnd network mismatch', 1)
}, { stopped: () => stopping })
