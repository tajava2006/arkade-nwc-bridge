import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LightningConfigError, parseLightningConfig } from '../../src/lightning_config'

const CARD = { version: 0, name: 'ours', discovery_pubkey: 'ab'.repeat(32), markets: [{ base_asset: {} }] }
const EMU = '02' + 'c7'.repeat(32)
const valid = () => ({ solverUrl: 'http://intent-solver:8787/', solverCard: CARD, subdustdUrl: 'http://subdustd:9010', emulatorPubkey: EMU })

const problems = (raw: unknown, baseDir = '/nonexistent'): string => {
  try {
    parseLightningConfig(raw, baseDir)
    return ''
  } catch (e) {
    if (e instanceof LightningConfigError) return e.message
    throw e
  }
}

describe('parseLightningConfig', () => {
  test('absent means Ark-only, not an error', () => {
    expect(parseLightningConfig(undefined, '/')).toBeUndefined()
    expect(parseLightningConfig(null, '/')).toBeUndefined()
  })

  test('a valid block parses, trailing slashes trimmed', () => {
    expect(parseLightningConfig(valid(), '/')).toEqual({
      solverUrl: 'http://intent-solver:8787',
      solverCard: CARD,
      subdustdUrl: 'http://subdustd:9010',
      emulatorPubkey: EMU,
    })
  })

  test('the card can come from a file next to the config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-ln-'))
    writeFileSync(join(dir, 'card.json'), JSON.stringify(CARD))
    const { solverCard: _, ...rest } = valid()
    expect(parseLightningConfig({ ...rest, solverCardPath: 'card.json' }, dir)?.solverCard).toEqual(CARD)
  })

  test('the emulator key must be a real compressed key — never silently the SDK default', () => {
    expect(problems({ ...valid(), emulatorPubkey: undefined })).toContain('lightning.emulatorPubkey')
    expect(problems({ ...valid(), emulatorPubkey: 'c7'.repeat(32) })).toContain('lightning.emulatorPubkey')
  })

  test('typos and missing pieces refuse, all reported at once', () => {
    const msg = problems({ solverURL: 'http://x', emulatorPubkey: EMU })
    expect(msg).toContain('lightning.solverURL: unknown key')
    expect(msg).toContain('lightning.solverUrl: required')
    expect(msg).toContain('lightning.subdustdUrl: required')
    expect(msg).toContain('lightning.solverCard: required')
  })

  test('a card without markets, a missing card file, or both card forms refuse', () => {
    expect(problems({ ...valid(), solverCard: { ...CARD, markets: [] } })).toContain('lightning.solverCard')
    const { solverCard: _, ...rest } = valid()
    expect(problems({ ...rest, solverCardPath: 'absent.json' })).toContain('lightning.solverCardPath')
    expect(problems({ ...valid(), solverCardPath: 'x.json' })).toContain('not both')
  })
})
