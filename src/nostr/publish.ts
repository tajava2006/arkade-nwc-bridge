import type { SimplePool } from 'nostr-tools/pool'
import type { NostrEvent } from 'nostr-tools/pure'

/**
 * Publish to every relay, but never let a single relay's timeout/rejection
 * tank the caller. nostr-tools' SimplePool returns one promise per relay
 * and pool.publish() resolves them independently — Promise.all would
 * reject as soon as any relay fails, which on boot crashes the bridge
 * before it ever finishes subscribing.
 *
 * Treat publishing as best-effort: log per-relay failures, succeed as
 * long as we tried.
 */
export async function publishToRelays(
  pool: SimplePool,
  relays: string[],
  signed: NostrEvent,
  context: string,
): Promise<void> {
  const results = await Promise.allSettled(pool.publish(relays, signed))
  const failures = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ relay: relays[i] ?? '?', reason: r.reason }] : [],
  )
  if (failures.length > 0) {
    for (const f of failures) {
      console.warn(
        `nostr: publish failed for ${context} on ${f.relay}: ${
          f.reason instanceof Error ? f.reason.message : String(f.reason)
        }`,
      )
    }
  }
}
