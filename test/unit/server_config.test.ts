import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openTempDb, type TempDb } from '../helpers/db'
import { ARK_SERVER_URL, BOLTZ_API_URL } from '../../src/defaults'
import {
  getServerRow,
  setServerRow,
  clearServerRow,
  resolveServerSet,
} from '../../src/server_config'

describe('server_config: bridge_server single row', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('getServerRow is null before the first write', () => {
    expect(getServerRow(temp.db)).toBeNull()
  })

  test('setServerRow writes exactly one row (id=1) that getServerRow reads back', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.a', boltzApiUrl: 'https://boltz.a' })
    expect(getServerRow(temp.db)).toEqual({
      arkServerUrl: 'https://ark.a',
      boltzApiUrl: 'https://boltz.a',
    })
    const c = temp.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM bridge_server').get()
    expect(c?.c).toBe(1)
  })

  test('setServerRow upserts — a second write overwrites, still one row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.a', boltzApiUrl: 'https://boltz.a' })
    setServerRow(temp.db, { arkServerUrl: 'https://ark.b', boltzApiUrl: 'https://boltz.b' })
    expect(getServerRow(temp.db)).toEqual({
      arkServerUrl: 'https://ark.b',
      boltzApiUrl: 'https://boltz.b',
    })
    const c = temp.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM bridge_server').get()
    expect(c?.c).toBe(1)
  })

  test('the CHECK (id=1) constraint rejects any second row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.a', boltzApiUrl: 'https://boltz.a' })
    expect(() =>
      temp.db
        .query('INSERT INTO bridge_server (id, ark_url, boltz_url, created_at) VALUES (2, ?, ?, ?)')
        .run('https://ark.b', 'https://boltz.b', 1),
    ).toThrow()
  })

  test('clearServerRow removes the row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.a', boltzApiUrl: 'https://boltz.a' })
    clearServerRow(temp.db)
    expect(getServerRow(temp.db)).toBeNull()
  })
})

describe('server_config: resolveServerSet precedence (config.json > row > defaults)', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('no row, no override → defaults', () => {
    expect(resolveServerSet(temp.db, {})).toEqual({
      arkServerUrl: ARK_SERVER_URL,
      boltzApiUrl: BOLTZ_API_URL,
    })
  })

  test('row, no override → row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.row', boltzApiUrl: 'https://boltz.row' })
    expect(resolveServerSet(temp.db, {})).toEqual({
      arkServerUrl: 'https://ark.row',
      boltzApiUrl: 'https://boltz.row',
    })
  })

  test('override wins over the row, per field', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.row', boltzApiUrl: 'https://boltz.row' })
    // only ark pinned by config.json → boltz still resolves from the row
    expect(resolveServerSet(temp.db, { arkServerUrl: 'https://ark.cfg' })).toEqual({
      arkServerUrl: 'https://ark.cfg',
      boltzApiUrl: 'https://boltz.row',
    })
    // both pinned
    expect(
      resolveServerSet(temp.db, {
        arkServerUrl: 'https://ark.cfg',
        boltzApiUrl: 'https://boltz.cfg',
      }),
    ).toEqual({ arkServerUrl: 'https://ark.cfg', boltzApiUrl: 'https://boltz.cfg' })
  })

  test('override with no row falls through to defaults for the unpinned field', () => {
    expect(resolveServerSet(temp.db, { boltzApiUrl: 'https://boltz.cfg' })).toEqual({
      arkServerUrl: ARK_SERVER_URL,
      boltzApiUrl: 'https://boltz.cfg',
    })
  })
})
