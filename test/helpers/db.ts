import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { openDatabase } from '../../src/db'

export interface TempDb {
  db: Database
  path: string
  cleanup(): void
}

export function openTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'nwc-bridge-test-'))
  const path = join(dir, 'bridge.sqlite')
  const db = openDatabase(path)
  return {
    db,
    path,
    cleanup() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
