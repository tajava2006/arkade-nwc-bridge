import type { Config } from '../config'

const NETWORK_NAMES: Record<Config['network'], string> = {
  bitcoin: 'mainnet',
  signet: 'signet',
  mutinynet: 'signet',
  regtest: 'regtest',
}

export interface GetInfoDeps {
  cfg: Config
}

export function handleGetInfo({ cfg }: GetInfoDeps): unknown {
  return {
    network: NETWORK_NAMES[cfg.network],
    methods: ['get_info', 'get_balance', 'make_invoice', 'pay_invoice'],
  }
}
