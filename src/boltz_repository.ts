import type { Database } from 'bun:sqlite'
import type { BoltzSwap, SwapRepository } from '@arkade-os/boltz-swap'

// SwapRepository.getAllSwaps' filter type isn't exported at the package root —
// derive the shape from the interface instead of importing the unexported name.
type SwapsFilter = Parameters<SwapRepository['getAllSwaps']>[0]

interface SwapRow {
  id: string
  type: string
  status: string
  created_at: number
  data: string
}

/**
 * sqlite-backed implementation of @arkade-os/boltz-swap's SwapRepository.
 *
 * id/type/status/created_at are indexed columns; the full BoltzSwap object is
 * stored as a JSON blob in `data`. The bridge never queries swap internals
 * directly (the SDK does that on its own pending-swap objects after fetch),
 * so we don't need to normalize per-variant fields — that would only couple
 * us to the SDK's data shape and break when it evolves.
 */
export class SqliteSwapRepository implements SwapRepository {
  readonly version = 1

  constructor(private readonly db: Database) {}

  async saveSwap<T extends BoltzSwap>(swap: T): Promise<void> {
    this.db
      .query(
        `INSERT INTO boltz_swaps (id, type, status, created_at, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           status = excluded.status,
           created_at = excluded.created_at,
           data = excluded.data`,
      )
      .run(swap.id, swap.type, swap.status, swap.createdAt, JSON.stringify(swap))
  }

  async deleteSwap(id: string): Promise<void> {
    this.db.query('DELETE FROM boltz_swaps WHERE id = ?').run(id)
  }

  async getAllSwaps<T extends BoltzSwap>(filter?: SwapsFilter): Promise<T[]> {
    const where: string[] = []
    const params: string[] = []

    if (filter?.id !== undefined) {
      const ids = Array.isArray(filter.id) ? filter.id : [filter.id]
      if (ids.length === 0) return []
      where.push(`id IN (${ids.map(() => '?').join(', ')})`)
      params.push(...ids)
    }
    if (filter?.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      if (statuses.length === 0) return []
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    }
    if (filter?.type !== undefined) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type]
      if (types.length === 0) return []
      where.push(`type IN (${types.map(() => '?').join(', ')})`)
      params.push(...types)
    }

    const orderDirection = filter?.orderDirection === 'desc' ? 'DESC' : 'ASC'
    const sql =
      `SELECT * FROM boltz_swaps` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY created_at ${orderDirection}`

    const rows = this.db.query<SwapRow, string[]>(sql).all(...params)
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  async clear(): Promise<void> {
    this.db.query('DELETE FROM boltz_swaps').run()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // The sqlite handle is owned by the bridge process — closing it is the
    // shutdown path's responsibility, not this repo's.
  }
}
