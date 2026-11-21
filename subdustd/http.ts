import type { ReceiveService } from './api/receive.ts'
import type { SendService } from './api/send.ts'
import { HttpError } from './api/http_error.ts'
import type { SubdustdConfig } from './config.ts'
import type { Logger } from './log.ts'
import type { PushHub } from './push.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export interface Api {
  send?: SendService
  receive?: ReceiveService
  push?: PushHub
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
  const send = api?.send
  if (send) {
    routes[`${PREFIX}/send/init`] = { POST: handle(log, async (r) => send.init(await body(r))) }
    routes[`${PREFIX}/send/fund`] = { POST: handle(log, async (r) => send.fund(await body(r))) }
    routes[`${PREFIX}/send/cancel`] = { POST: handle(log, async (r) => send.cancel(await body(r))) }
    routes[`${PREFIX}/send/status`] = { GET: handle(log, (r) => send.status(query(r))) }
  }
  const receive = api?.receive
  if (receive) {
    routes[`${PREFIX}/receive/init`] = { POST: handle(log, async (r) => receive.init(await body(r))) }
    routes[`${PREFIX}/receive/status`] = { GET: handle(log, (r) => receive.status(query(r))) }
    routes[`${PREFIX}/receive/settle`] = { POST: handle(log, async (r) => receive.settle(await body(r))) }
  }
  const push = api?.push
  const server = Bun.serve({
    hostname: config.http.host,
    port: config.http.port,
    routes,
    fetch: (req, srv) => {
      if (push && new URL(req.url).pathname === '/v2/ws') {
        if (srv.upgrade(req, { data: push.newSocketData() })) return undefined
        return json({ error: 'websocket upgrade required' }, 426)
      }
      return json({ error: 'not found' }, 404)
    },
    websocket: push?.websocket ?? { message() {} },
    error: (e) => {
      log.error(`http: ${e.stack ?? e.message}`)
      return json({ error: 'internal error' }, 500)
    },
  })
  log.info(`http listening on ${server.hostname}:${server.port}`)
  return server
}
