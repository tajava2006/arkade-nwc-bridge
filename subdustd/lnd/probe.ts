import type { Network } from '../config.ts'
import type { Logger } from '../log.ts'
import { probeUntilAnswered } from '../probe.ts'
import type { LndClient, NodeInfo } from './client.ts'

const LND_CHAINS: Record<Network, readonly string[]> = {
  bitcoin: ['mainnet'],
  testnet: ['testnet', 'testnet4'],
  signet: ['signet'],
  mutinynet: ['signet'],
  regtest: ['regtest'],
}

export const lndNetworkMismatch = (network: Network, info: Pick<NodeInfo, 'network'>): string | undefined =>
  LND_CHAINS[network].includes(info.network)
    ? undefined
    : `LND is on ${info.network || 'an unknown chain'} but config.network is ${network} — refusing to run`

export const probeLnd = (
  lnd: Pick<LndClient, 'getInfo'>,
  network: Network,
  log: Logger,
  onFatal: (reason: string) => void,
  opts: { retryMs?: number; stopped?: () => boolean } = {},
): Promise<NodeInfo | undefined> =>
  probeUntilAnswered(
    {
      name: 'lnd',
      ask: () => lnd.getInfo(),
      mismatch: (info) => lndNetworkMismatch(network, info),
      describe: (info) => `lnd ${info.version} ${info.pubkey} on ${info.network}, height ${info.blockHeight}`,
    },
    log,
    onFatal,
    opts,
  )
