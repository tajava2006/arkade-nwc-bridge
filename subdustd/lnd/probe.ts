import type { Network } from '../config.ts'
import type { Logger } from '../log.ts'
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

/**
 * Boot-time look at LND, in the background. A wrong chain is fatal (a regtest
 * config against a mainnet node would mint real hold invoices with drill knobs).
 * An unreachable LND is not: the process still has old swaps to settle and
 * refund, and new swaps refuse on their own until LND answers.
 */
export const probeLnd = async (
  lnd: Pick<LndClient, 'getInfo'>,
  network: Network,
  log: Logger,
  onFatal: (reason: string) => void,
  opts: { retryMs?: number; stopped?: () => boolean } = {},
): Promise<void> => {
  const retryMs = opts.retryMs ?? 10_000
  for (let attempt = 1; !opts.stopped?.(); attempt++) {
    try {
      const info = await lnd.getInfo()
      const mismatch = lndNetworkMismatch(network, info)
      if (mismatch) return onFatal(mismatch)
      log.info(`lnd ${info.version} ${info.pubkey} on ${info.network}, height ${info.blockHeight}`)
      return
    } catch (e) {
      if (attempt === 1 || attempt % 30 === 0) {
        log.warn(`lnd unreachable (attempt ${attempt}, new swaps will refuse until it answers): ${(e as Error).message}`)
      }
    }
    await Bun.sleep(retryMs)
  }
}
