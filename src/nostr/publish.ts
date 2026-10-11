import type { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, type EventTemplate, type NostrEvent, type VerifiedEvent } from 'nostr-tools/pure'

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
export interface PublishOptions {
  /**
   * Answer a relay's NIP-42 challenge with this key when it rejects the
   * publish as `auth-required:`, then publish again. Opt-in per call
   * because authenticating names a pubkey to the relay: the operator's DM
   * inbox relay may know the account key (it is the DM's recipient anyway),
   * but a per-connection NWC service key should not be tied to the account
   * on relays the wallet client picked.
   */
  authKey?: Uint8Array
}

function authSigner(secretKey: Uint8Array) {
  return async (template: EventTemplate): Promise<VerifiedEvent> => finalizeEvent(template, secretKey)
}

export async function publishToRelays(
  pool: SimplePool,
  relays: string[],
  signed: NostrEvent,
  context: string,
  opts: PublishOptions = {},
): Promise<void> {
  const results = await Promise.allSettled(
    pool.publish(relays, signed, opts.authKey ? { onauth: authSigner(opts.authKey) } : undefined),
  )
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
