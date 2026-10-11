// A WebSocket that nostr-tools can ping at the protocol level.
//
// nostr-tools' keepalive checks `ws.ping && ws.once`: with both it sends a
// real WebSocket ping frame and waits for the pong; without `once` it falls
// back to a dummy REQ and waits for the relay's EOSE. Bun's WebSocket has
// ping() and emits 'pong', but has no Node-style once(), so the bridge was
// always on the fallback — and the fallback declares the socket dead when
// EOSE does not arrive within 20s.
//
// That is a statement about the relay's query path, not about the socket.
// nostr.bitcoiner.social stopped answering REQs with EOSE (2026-10) while
// still relaying live events and accepting publishes, so every connection
// to it was closed by us ~49s after opening (29s ping interval + 20s
// timeout), forever. A pong only says what we actually want to know: the
// peer is there. All relays the bridge uses answer it.
export class PingableWebSocket extends WebSocket {
  once(event: string, listener: () => void): void {
    this.addEventListener(event, listener, { once: true })
  }
}
