import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkConfigFiles, ConfigError, DEFAULT_KNOBS, loadConfig, parseConfig } from '../../subdustd/config.ts'
import { createLogger } from '../../subdustd/log.ts'

const minimal = () => ({
  network: 'regtest',
  arkdUrl: 'http://arkd:7070',
  lnd: { socket: 'lnd:10009', certPath: '/lnd/tls.cert', macaroonPath: '/lnd/m.macaroon' },
  keyPath: '/data/k',
  dbPath: '/data/db.sqlite',
})

const problemsOf = (raw: unknown): string[] => {
  try {
    parseConfig(raw)
  } catch (e) {
    if (e instanceof ConfigError) return e.problems
    throw e
  }
  return []
}

describe('parseConfig', () => {
  test('minimal config gets the tuned mainnet knobs and a loopback bind', () => {
    const { config, warnings } = parseConfig(minimal())
    expect(config.subdust).toEqual(DEFAULT_KNOBS)
    expect(config.http).toEqual({ host: '127.0.0.1', port: 9010 })
    expect(config.logLevel).toBe('info')
    expect(warnings).toEqual([])
  })

  test('defaults are the live boltz.conf values, not the fork code defaults', () => {
    expect(DEFAULT_KNOBS).toEqual({
      sendWindowSecs: 324_000,
      receiveWindowSecs: 21_600,
      payMarginSecs: 600,
      blockTimeSecs: 600,
      sendFeePercent: 0.5,
    })
  })

  test('the regtest drill knobs are accepted (receive margin may equal the receive window)', () => {
    const { config } = parseConfig({
      ...minimal(),
      subdust: { sendWindowSecs: 3600, receiveWindowSecs: 60, payMarginSecs: 60, blockTimeSecs: 30 },
    })
    expect(config.subdust).toEqual({ ...DEFAULT_KNOBS, sendWindowSecs: 3600, receiveWindowSecs: 60, payMarginSecs: 60, blockTimeSecs: 30 })
  })

  test('a misspelled knob fails instead of falling back to its default', () => {
    expect(problemsOf({ ...minimal(), subdust: { sendWindow: 3600 } })).toEqual(['config.subdust.sendWindow: unknown key'])
    expect(problemsOf({ ...minimal(), lnd: { ...minimal().lnd, macaroon: 'x' } })).toContain('config.lnd.macaroon: unknown key')
    expect(problemsOf({ ...minimal(), signerKey: 'ab' })).toEqual(['config.signerKey: unknown key'])
  })

  test('every missing required field is reported at once', () => {
    const p = problemsOf({})
    for (const key of ['network', 'arkdUrl', 'keyPath', 'dbPath']) {
      expect(p.some((x) => x.startsWith(`config.${key}:`))).toBe(true)
    }
    expect(p).toContain('config.lnd: expected an object')
  })

  test('rejects a send window with no LN budget left', () => {
    expect(problemsOf({ ...minimal(), subdust: { sendWindowSecs: 600, payMarginSecs: 600 } })).toEqual([
      'config.subdust: payMarginSecs must be < sendWindowSecs (no LN cltv budget left)',
    ])
  })

  test('rejects non-integer, zero and wrongly typed knobs', () => {
    expect(problemsOf({ ...minimal(), subdust: { sendWindowSecs: 3600.5 } })).toHaveLength(1)
    expect(problemsOf({ ...minimal(), subdust: { blockTimeSecs: 0 } })).toHaveLength(1)
    expect(problemsOf({ ...minimal(), subdust: { receiveWindowSecs: '21600' } })).toHaveLength(1)
    expect(problemsOf({ ...minimal(), subdust: { sendFeePercent: -1 } })).toHaveLength(1)
    expect(problemsOf({ ...minimal(), subdust: { sendFeePercent: 100 } })).toEqual(['config.subdust.sendFeePercent: must be < 100'])
  })

  test('rejects a bad network, URL, socket and port', () => {
    expect(problemsOf({ ...minimal(), network: 'mainnet' })[0]).toStartWith('config.network: must be one of')
    expect(problemsOf({ ...minimal(), arkdUrl: 'arkd:7070' })).toEqual(['config.arkdUrl: must be an http(s) URL'])
    expect(problemsOf({ ...minimal(), lnd: { ...minimal().lnd, socket: 'lnd' } })).toEqual(['config.lnd.socket: must be host:port'])
    expect(problemsOf({ ...minimal(), lnd: { ...minimal().lnd, socket: 'lnd:70000' } })).toEqual(['config.lnd.socket: port out of range'])
    expect(problemsOf({ ...minimal(), http: { port: 70000 } })).toEqual(['config.http.port: out of range'])
  })

  test('mainnet warns on a short send budget and a zero fee; regtest does not', () => {
    const knobs = { sendWindowSecs: 172_800, sendFeePercent: 0 }
    const { warnings } = parseConfig({ ...minimal(), network: 'bitcoin', subdust: knobs })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('287 blocks < 288')
    expect(parseConfig({ ...minimal(), subdust: knobs }).warnings).toEqual([])
    expect(parseConfig({ ...minimal(), network: 'bitcoin' }).warnings).toEqual([])
  })
})

describe('parseConfig — chain backend (F32_VHTLC_PLAN §7)', () => {
  test('absent: no executor (main warns the on-chain paths go unenforced)', () => {
    expect(parseConfig(minimal()).config.chain).toBeUndefined()
  })
  test('bitcoind or esplora, each fully specified', () => {
    expect(parseConfig({ ...minimal(), chain: { bitcoind: { url: 'http://172.28.0.1:8332', user: 'u', passwordPath: '/secrets/btc.pass' } } }).config.chain).toEqual({
      kind: 'bitcoind',
      url: 'http://172.28.0.1:8332',
      user: 'u',
      passwordPath: '/secrets/btc.pass',
    })
    expect(parseConfig({ ...minimal(), chain: { esplora: { url: 'https://mempool.space/api' } } }).config.chain).toEqual({
      kind: 'esplora',
      url: 'https://mempool.space/api',
    })
  })
  test('exactly one backend; no inline password; a real URL', () => {
    expect(problemsOf({ ...minimal(), chain: {} })).toContain('config.chain: exactly one of bitcoind or esplora')
    expect(problemsOf({ ...minimal(), chain: { bitcoind: { url: 'http://x:1', user: 'u', passwordPath: '/p' }, esplora: { url: 'http://y' } } })).toContain(
      'config.chain: exactly one of bitcoind or esplora',
    )
    expect(problemsOf({ ...minimal(), chain: { bitcoind: { url: 'http://x:1', user: 'u', password: 'p' } } }).join()).toContain('unknown key')
    expect(problemsOf({ ...minimal(), chain: { esplora: { url: 'mempool.space' } } })).toContain('config.chain.esplora.url: must be an http(s) URL')
  })
})

describe('loadConfig / checkConfigFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subdustd-'))

  test('unparseable JSON is a ConfigError naming the file', () => {
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{ "network": ')
    expect(() => loadConfig(path)).toThrow(ConfigError)
    expect(() => loadConfig(join(dir, 'absent.json'))).toThrow(ConfigError)
  })

  test('unreadable LND/key files are reported together', () => {
    const { config } = parseConfig(minimal())
    try {
      checkConfigFiles(config)
      throw new Error('expected ConfigError')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      expect((e as ConfigError).problems.map((p) => p.split(':')[0])).toEqual([
        'config.lnd.certPath',
        'config.lnd.macaroonPath',
        'config.keyPath',
      ])
    }
  })

  test('readable files pass', () => {
    for (const f of ['cert', 'mac', 'key']) writeFileSync(join(dir, f), 'x')
    const { config } = parseConfig({
      ...minimal(),
      lnd: { socket: 'lnd:10009', certPath: join(dir, 'cert'), macaroonPath: join(dir, 'mac') },
      keyPath: join(dir, 'key'),
    })
    expect(() => checkConfigFiles(config)).not.toThrow()
  })
})

describe('createLogger', () => {
  test('drops lines below the level and routes warn/error to stderr', () => {
    const lines: [string, boolean][] = []
    const log = createLogger('warn', (line, isError) => lines.push([line, isError]))
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(lines.map(([l, isError]) => [l.split(' ').slice(1).join(' '), isError])).toEqual([
      ['WARN  w', true],
      ['ERROR e', true],
    ])
  })
})
