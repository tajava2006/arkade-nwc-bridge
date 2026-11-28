import { describe, expect, test } from 'bun:test'
import type { NodeInfo } from '../../subdustd/lnd/client.ts'
import { lndNetworkMismatch, probeLnd } from '../../subdustd/lnd/probe.ts'
import { createLogger } from '../../subdustd/log.ts'

const info = (network: string): NodeInfo => ({ pubkey: '02aa', network, version: '0.21.5-beta', blockHeight: 1, syncedToChain: true })
const quiet = createLogger('error', () => {})

describe('lndNetworkMismatch', () => {
  test('maps our network names onto LND chain names', () => {
    expect(lndNetworkMismatch('bitcoin', info('mainnet'))).toBeUndefined()
    expect(lndNetworkMismatch('regtest', info('regtest'))).toBeUndefined()
    expect(lndNetworkMismatch('mutinynet', info('signet'))).toBeUndefined()
    expect(lndNetworkMismatch('testnet', info('testnet4'))).toBeUndefined()
  })

  test('a regtest config against a mainnet node is a mismatch', () => {
    expect(lndNetworkMismatch('regtest', info('mainnet'))).toContain('LND is on mainnet but config.network is regtest')
    expect(lndNetworkMismatch('bitcoin', info(''))).toContain('an unknown chain')
  })
})

describe('probeLnd', () => {
  test('keeps retrying while LND is down, then logs and returns once it answers', async () => {
    let calls = 0
    const fatal: string[] = []
    await probeLnd(
      {
        getInfo: async () => {
          if (++calls < 3) throw new Error('unavailable')
          return info('regtest')
        },
      },
      'regtest',
      quiet,
      (r) => fatal.push(r),
      { retryMs: 1 },
    )
    expect(calls).toBe(3)
    expect(fatal).toEqual([])
  })

  test('a chain mismatch is fatal', async () => {
    const fatal: string[] = []
    await probeLnd({ getInfo: async () => info('mainnet') }, 'regtest', quiet, (r) => fatal.push(r), { retryMs: 1 })
    expect(fatal).toHaveLength(1)
  })

  test('stops retrying on shutdown', async () => {
    let calls = 0
    let stop = false
    await probeLnd(
      {
        getInfo: async () => {
          if (++calls === 2) stop = true
          throw new Error('unavailable')
        },
      },
      'regtest',
      quiet,
      () => {},
      { retryMs: 1, stopped: () => stop },
    )
    expect(calls).toBe(2)
  })
})
