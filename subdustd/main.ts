import { checkConfigFiles, ConfigError, loadConfig, type SubdustdConfig } from './config.ts'
import { startHttp } from './http.ts'
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

const server = startHttp(config, log)

const shutdown = (signal: string) => {
  log.info(`${signal}: shutting down`)
  server.stop(true)
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
