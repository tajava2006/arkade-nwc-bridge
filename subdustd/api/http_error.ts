// Same error shape the Boltz fork served (`{ error }`, 400 by default), so the
// bridge's existing client reads subdustd unchanged.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (message: string) => new HttpError(400, message)

interface ArgSpec {
  name: string
  type: 'string' | 'number' | 'object'
  optional?: boolean
}

export const validateArgs = (body: unknown, specs: readonly ArgSpec[]): Record<string, unknown> => {
  const src = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const spec of specs) {
    const value = src[spec.name]
    if (value === undefined || value === null) {
      if (!spec.optional) throw badRequest(`undefined parameter: ${spec.name}`)
      continue
    }
    if (typeof value !== spec.type || (spec.type === 'number' && !Number.isFinite(value))) {
      throw badRequest(`invalid parameter: ${spec.name}`)
    }
    out[spec.name] = value
  }
  return out
}

/** A counterparty key: 32-byte x-only hex, or a 33-byte compressed key reduced to x-only. */
export const xOnlyHex = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || !/^([0-9a-fA-F]{64}|0[23][0-9a-fA-F]{64})$/.test(value)) {
    throw badRequest(`invalid parameter: ${name}`)
  }
  return (value.length === 66 ? value.slice(2) : value).toLowerCase()
}

/** Exactly one of fund / cancel / resume may touch a swap at a time. */
export class SwapLocks {
  private readonly held = new Set<string>()

  tryAcquire(id: string): (() => void) | undefined {
    if (this.held.has(id)) return undefined
    this.held.add(id)
    return () => this.held.delete(id)
  }

  isHeld(id: string): boolean {
    return this.held.has(id)
  }
}
