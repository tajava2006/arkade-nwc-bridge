import { describe, expect, test } from 'bun:test'
import { LightningConfigError, parseLightningConfig } from '../../src/lightning_config'

const problems = (raw: unknown): string => {
  try {
    parseLightningConfig(raw)
    return ''
  } catch (e) {
    if (e instanceof LightningConfigError) return e.message
    throw e
  }
}

describe('parseLightningConfig', () => {
  test('absent means Ark-only, not an error', () => {
    expect(parseLightningConfig(undefined)).toBeUndefined()
    expect(parseLightningConfig(null)).toBeUndefined()
  })

  test('a valid block parses, trailing slashes trimmed', () => {
    expect(parseLightningConfig({ subdustdUrl: 'http://subdustd:9010/' })).toEqual({ subdustdUrl: 'http://subdustd:9010' })
  })

  test('typos and a missing URL refuse, all reported at once', () => {
    const msg = problems({ subdustdURL: 'http://x' })
    expect(msg).toContain('lightning.subdustdURL: unknown key')
    expect(msg).toContain('lightning.subdustdUrl: required')
    expect(problems({ subdustdUrl: 'subdustd:9010' })).toContain('lightning.subdustdUrl: required http(s) URL')
    expect(problems('http://x')).toContain('expected an object')
  })

  test('a solver-era block refuses with the reason, not as a typo (D11)', () => {
    const msg = problems({
      solverUrl: 'http://intent-solver:8787',
      solverCardPath: 'card.json',
      subdustdUrl: 'http://subdustd:9010',
      emulatorPubkey: '02' + 'c7'.repeat(32),
    })
    for (const k of ['solverUrl', 'solverCardPath', 'emulatorPubkey']) expect(msg).toContain(`lightning.${k}: no longer used`)
    expect(msg).not.toContain('subdustdUrl')
  })
})
