import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openTempDb, type TempDb } from '../helpers/db'
import { ARK_SERVER_URL } from '../../src/defaults'
import { getServerRow, setServerRow, clearServerRow, resolveServerSet } from '../../src/server_config'

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

  test('setServerRow writes exactly one row (id=1) that getServerRow reads back; boltz_url is left empty', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.a' })
    expect(getServerRow(temp.db)).toEqual({ arkServerUrl: 'https://ark.a' })
    const row = temp.db.query<{ c: number; boltz: string }, []>('SELECT COUNT(*) AS c, MAX(boltz_url) AS boltz FROM bridge_server').get()
    expect(row).toEqual({ c: 1, boltz: '' })
  })

  test('setServerRow upserts — a second write overwrites, still one row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.a' })
    setServerRow(temp.db, { arkServerUrl: 'https://ark.b' })
    expect(getServerRow(temp.db)).toEqual({ arkServerUrl: 'https://ark.b' })
    const c = temp.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM bridge_server').get()
    expect(c?.c).toBe(1)
  })

  test('a Boltz-era row (boltz_url filled) still reads back its Ark server', () => {
    temp.db
      .query('INSERT INTO bridge_server (id, ark_url, boltz_url, created_at) VALUES (1, ?, ?, ?)')
      .run('https://ark.old', 'https://boltz.old', 1)
    expect(getServerRow(temp.db)).toEqual({ arkServerUrl: 'https://ark.old' })
  })

  test('the CHECK (id=1) constraint rejects any second row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.a' })
    expect(() =>
      temp.db.query('INSERT INTO bridge_server (id, ark_url, boltz_url, created_at) VALUES (2, ?, ?, ?)').run('https://ark.b', '', 1),
    ).toThrow()
  })

  test('clearServerRow removes the row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.a' })
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
    expect(resolveServerSet(temp.db, {})).toEqual({ arkServerUrl: ARK_SERVER_URL })
  })

  test('row, no override → row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.row' })
    expect(resolveServerSet(temp.db, {})).toEqual({ arkServerUrl: 'https://ark.row' })
  })

  test('override wins over the row', () => {
    setServerRow(temp.db, { arkServerUrl: 'https://ark.row' })
    expect(resolveServerSet(temp.db, { arkServerUrl: 'https://ark.cfg' })).toEqual({ arkServerUrl: 'https://ark.cfg' })
  })
})
