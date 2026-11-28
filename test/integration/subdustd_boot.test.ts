import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real process: boots on a valid config, serves /healthz, exits on SIGTERM,
// and refuses to boot (non-zero, no listener) on a broken one.

const dir = mkdtempSync(join(tmpdir(), 'subdustd-boot-'))
for (const f of ['mac', 'garbage-cert', 'garbage-key']) writeFileSync(join(dir, f), 'x')
writeFileSync(join(dir, 'key'), `${'11'.repeat(32)}\n`, { mode: 0o600 })
// A parseable cert is all boot needs; no LND has to answer it.
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
  '-subj', '/CN=localhost', '-keyout', join(dir, 'cert.key'), '-out', join(dir, 'cert'),
], { stdio: 'ignore' })

const writeConfig = (name: string, extra: Record<string, unknown>) => {
  const path = join(dir, name)
  writeFileSync(
    path,
    JSON.stringify({
      network: 'regtest',
      arkdUrl: 'http://127.0.0.1:7070',
      lnd: { socket: '127.0.0.1:1', certPath: join(dir, 'cert'), macaroonPath: join(dir, 'mac') },
      keyPath: join(dir, 'key'),
      dbPath: join(dir, 'db.sqlite'),
      ...extra,
    }),
  )
  return path
}

const spawnDaemon = (configPath: string) =>
  Bun.spawn(['bun', 'run', 'subdustd/main.ts', configPath], { stdout: 'pipe', stderr: 'pipe' })

const children: ReturnType<typeof spawnDaemon>[] = []
afterAll(() => {
  for (const c of children) c.kill()
})

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = s.port
  s.stop(true)
  return port
}

describe('subdustd boot', () => {
  test('serves /healthz and exits cleanly on SIGTERM', async () => {
    const port = freePort()
    const child = spawnDaemon(writeConfig('ok.json', { http: { host: '127.0.0.1', port } }))
    children.push(child)
    let res: Response | undefined
    for (let i = 0; i < 50 && !res; i++) {
      res = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)
      if (!res) await Bun.sleep(100)
    }
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ ok: true })
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404)

    // The push channel is served by the real process on the same port.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v2/ws`)
    const pong = new Promise((r) => ws.addEventListener('message', (e) => r(JSON.parse(String(e.data)))))
    await new Promise((r) => ws.addEventListener('open', r, { once: true }))
    ws.send(JSON.stringify({ op: 'ping' }))
    expect(await pong).toEqual({ event: 'pong' })
    ws.close()

    const hc = Bun.spawn(['bun', 'run', 'subdustd/healthcheck.ts', join(dir, 'ok.json')])
    expect(await hc.exited).toBe(0)

    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
  }, 20_000)

  test('refuses to boot on a misspelled knob', async () => {
    const child = spawnDaemon(writeConfig('typo.json', { subdust: { sendWindow: 3600 } }))
    children.push(child)
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('config.subdust.sendWindow: unknown key')
  }, 20_000)

  test('refuses to boot when the key file is missing', async () => {
    const child = spawnDaemon(writeConfig('nokey.json', { keyPath: join(dir, 'absent') }))
    children.push(child)
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('config.keyPath:')
  }, 20_000)

  test('refuses to boot on a key file that is not a secret key', async () => {
    const child = spawnDaemon(writeConfig('badkey.json', { keyPath: join(dir, 'garbage-key') }))
    children.push(child)
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('expected 64 hex characters')
  }, 20_000)

  test('refuses to boot on a cert that does not parse', async () => {
    const child = spawnDaemon(writeConfig('badcert.json', { lnd: { socket: '127.0.0.1:1', certPath: join(dir, 'garbage-cert'), macaroonPath: join(dir, 'mac') } }))
    children.push(child)
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('config.lnd: cannot load the TLS cert')
  }, 20_000)

  test('healthcheck fails when nothing is listening', async () => {
    const hc = Bun.spawn(['bun', 'run', 'subdustd/healthcheck.ts', writeConfig('down.json', { http: { port: freePort() } })])
    expect(await hc.exited).toBe(1)
  }, 20_000)
})
