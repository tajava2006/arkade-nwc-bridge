import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lnPaymentIsDead } from '../../subdustd/cancel_gate.ts'
import { LndClient, LndError } from '../../subdustd/lnd/client.ts'

// "LND did not answer" must refuse the cancel, and must do so promptly: a dead
// port and a peer that accepts the socket but never speaks (the hang the unary
// deadline exists for). No LND needed — only a throwaway cert to dial with.

const dir = mkdtempSync(join(tmpdir(), 'subdustd-lnd-down-'))
let haveOpenssl = true
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
  ], { stdio: 'ignore' })
  writeFileSync(join(dir, 'mac'), Buffer.from('00', 'hex'))
} catch {
  haveOpenssl = false
}

const conn = (port: number) => ({ socket: `127.0.0.1:${port}`, certPath: join(dir, 'cert.pem'), macaroonPath: join(dir, 'mac') })
const hash = 'ab'.repeat(32)

const listen = (onConn: (s: Socket) => void) =>
  new Promise<Server>((resolve) => {
    const srv = createServer(onConn)
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
const portOf = (s: Server) => (s.address() as { port: number }).port

const servers: Server[] = []
const sockets: Socket[] = []
afterAll(() => {
  for (const s of sockets) s.destroy()
  for (const s of servers) s.close()
})

describe.skipIf(!haveOpenssl)('subdustd LndClient when LND does not answer', () => {
  test('nothing listening: calls fail UNAVAILABLE and the cancel gate refuses', async () => {
    const closed = await listen(() => {})
    const port = portOf(closed)
    await new Promise((r) => closed.close(r))
    const lnd = new LndClient(conn(port), 2_000)
    const err = await lnd.getInfo().catch((e) => e)
    expect(err).toBeInstanceOf(LndError)
    expect((err as LndError).code).toBe(14)
    expect(await lnPaymentIsDead(lnd, hash)).toEqual({ dead: false, reason: 'LND did not answer' })
    lnd.close()
  }, 15_000)

  test('a peer that accepts and then hangs: the deadline turns it into a refusal, not a stuck request', async () => {
    const hung = await listen((s) => sockets.push(s))
    servers.push(hung)
    const lnd = new LndClient(conn(portOf(hung)), 1_000)
    const t0 = Date.now()
    const err = await lnd.getInfo().catch((e) => e)
    expect(err).toBeInstanceOf(LndError)
    expect([4, 14]).toContain((err as LndError).code!)
    expect(await lnPaymentIsDead(lnd, hash)).toEqual({ dead: false, reason: 'LND did not answer' })
    expect(Date.now() - t0).toBeLessThan(5_000)
    lnd.close()
  }, 15_000)
})
