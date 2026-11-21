import type { SendService } from './api/send.ts'
import { HttpError } from './api/http_error.ts'
import type { SubdustdConfig } from './config.ts'
import type { Logger } from './log.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export interface Api {
  send: SendService
}

const PREFIX = '/v2/subdust/atomic'

// Errors keep the Boltz fork's shape: `{ error }`, 400 unless the handler says
// otherwise (503 = the LN outcome is unknown, poll the status endpoint).
const handle =
  (log: Logger, fn: (req: Request) => Promise<unknown> | unknown) =>
  async (req: Request): Promise<Response> => {
    try {
      return json(await fn(req))
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400
      const message = e instanceof Error ? e.message : String(e)
      if (status >= 500) log.warn(`${req.method} ${new URL(req.url).pathname}: ${message}`)
      else log.debug(`${req.method} ${new URL(req.url).pathname}: ${message}`)
      return json({ error: message }, status)
    }
  }

const body = async (req: Request): Promise<unknown> => {
  try {
    return await req.json()
  } catch {
    throw new HttpError(400, 'request body must be JSON')
  }
}
const query = (req: Request) => Object.fromEntries(new URL(req.url).searchParams)

// /healthz is liveness only. Readiness (LND, arkd) belongs to the swap paths
// that need them: a dead LND must refuse new swaps, not restart the process
// that is still sweeping and refunding the old ones.
export const startHttp = (config: SubdustdConfig, log: Logger, api?: Api) => {
  const routes: Record<string, Record<string, (req: Request) => Response | Promise<Response>>> = {
    '/healthz': { GET: () => json({ ok: true }) },
  }
  if (api) {
    routes[`${PREFIX}/send/init`] = { POST: handle(log, async (r) => api.send.init(await body(r))) }
    routes[`${PREFIX}/send/fund`] = { POST: handle(log, async (r) => api.send.fund(await body(r))) }
    routes[`${PREFIX}/send/cancel`] = { POST: handle(log, async (r) => api.send.cancel(await body(r))) }
    routes[`${PREFIX}/send/status`] = { GET: handle(log, (r) => api.send.status(query(r))) }
  }
  const server = Bun.serve({
    hostname: config.http.host,
    port: config.http.port,
    routes,
    fetch: () => json({ error: 'not found' }, 404),
    error: (e) => {
      log.error(`http: ${e.stack ?? e.message}`)
      return json({ error: 'internal error' }, 500)
    },
  })
  log.info(`http listening on ${server.hostname}:${server.port}`)
  return server
}
