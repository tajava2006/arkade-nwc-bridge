import type { SubdustdConfig } from './config.ts'
import type { Logger } from './log.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Liveness only. Readiness (LND, arkd) belongs to the swap paths that need
// them: a dead LND must refuse new swaps, not restart the process that is
// still sweeping and refunding the old ones.
export const startHttp = (config: SubdustdConfig, log: Logger) => {
  const server = Bun.serve({
    hostname: config.http.host,
    port: config.http.port,
    routes: {
      '/healthz': { GET: () => json({ ok: true }) },
    },
    fetch: () => json({ error: 'not found' }, 404),
    error: (e) => {
      log.error(`http: ${e.stack ?? e.message}`)
      return json({ error: 'internal error' }, 500)
    },
  })
  log.info(`http listening on ${server.hostname}:${server.port}`)
  return server
}
