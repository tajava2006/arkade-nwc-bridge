// The Ark SDK uses EventSource for SSE streams (settlement events, contract
// watching). Bun ships EventSource globally on recent versions, but install
// the eventsource package as a fallback so we don't depend on that.
import { EventSource as NodeEventSource } from 'eventsource'

const g = globalThis as { EventSource?: typeof EventSource }
if (!g.EventSource) {
  g.EventSource = NodeEventSource as unknown as typeof EventSource
}
