// Minimal Server-Sent Events hub. Holds the set of connected browser
// streams and broadcasts named events to all of them. The web layer owns
// the route that opens streams; everyone else just calls `broadcast`.
//
// SSE is the right fit here: one-way push from bridge to browser, native
// EventSource reconnect, plain text/event-stream over the same loopback
// HTTP server we already have. No websocket lifecycle to babysit.

type Controller = ReadableStreamDefaultController<Uint8Array>

export class SseHub {
  private encoder = new TextEncoder()
  private clients = new Set<Controller>()

  add(controller: Controller): void {
    this.clients.add(controller)
  }

  remove(controller: Controller): void {
    this.clients.delete(controller)
  }

  /**
   * Send a named event to one specific stream — used for initial
   * snapshots on connect, before any broadcast fires.
   */
  sendTo(controller: Controller, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    try {
      controller.enqueue(this.encoder.encode(payload))
    } catch {
      // Stream already closed — drop the client so future broadcasts
      // don't keep throwing.
      this.clients.delete(controller)
    }
  }

  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const bytes = this.encoder.encode(payload)
    for (const c of this.clients) {
      try {
        c.enqueue(bytes)
      } catch {
        this.clients.delete(c)
      }
    }
  }

  /**
   * Comment-only frame to keep idle connections alive through any
   * intermediary that times out silent streams. Loopback doesn't need
   * this in practice, but cheap insurance.
   */
  ping(): void {
    if (this.clients.size === 0) return
    const bytes = this.encoder.encode(': ping\n\n')
    for (const c of this.clients) {
      try {
        c.enqueue(bytes)
      } catch {
        this.clients.delete(c)
      }
    }
  }

  closeAll(): void {
    for (const c of this.clients) {
      try {
        c.close()
      } catch {
        // already closed
      }
    }
    this.clients.clear()
  }

  get size(): number {
    return this.clients.size
  }
}
