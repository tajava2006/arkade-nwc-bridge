import { EsploraProvider } from '@arkade-os/sdk'

// The exit path's own onchain view. Deliberately NOT derived from ASP info —
// the ASP being dead is the scenario this exists for — and deliberately dumb:
// probe the priority list once at construction, take the first endpoint that
// answers a tip-height read. Mid-session failover is out of scope (#06); the
// engine can be restarted against the next candidate, and every step of an
// unroll re-reads chain state anyway.

export interface ExitEsplora {
  provider: EsploraProvider
  url: string
  /** false = no candidate answered; provider still points at the first one so a transient outage self-heals on retry */
  healthy: boolean
}

export async function pickEsplora(
  urls: readonly string[],
  timeoutMs = 5_000,
): Promise<ExitEsplora> {
  if (urls.length === 0) throw new Error('esploraUrls must not be empty')
  for (const url of urls) {
    try {
      const res = await fetch(`${url}/blocks/tip/height`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) return { provider: new EsploraProvider(url), url, healthy: true }
    } catch {
      // dead or unreachable — try the next candidate
    }
  }
  return { provider: new EsploraProvider(urls[0]!), url: urls[0]!, healthy: false }
}
