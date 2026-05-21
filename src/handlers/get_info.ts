import type { Config } from '../config'
import { SUPPORTED_METHODS } from '../lib/methods'

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
    methods: [...SUPPORTED_METHODS],
  }
}
