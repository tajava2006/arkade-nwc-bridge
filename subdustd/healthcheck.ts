import { loadConfig } from './config.ts'

// Docker HEALTHCHECK: reads the port from the same config the daemon booted
// with, so moving the port in the file cannot silently fail every probe.
const path = process.argv[2] ?? '/config/subdustd.json'
try {
  const { config } = loadConfig(path)
  const host = config.http.host === '0.0.0.0' || config.http.host === '::' ? '127.0.0.1' : config.http.host
  const res = await fetch(`http://${host}:${config.http.port}/healthz`, { signal: AbortSignal.timeout(3000) })
  process.exit(res.ok ? 0 : 1)
} catch {
  process.exit(1)
}
