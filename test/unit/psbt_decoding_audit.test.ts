import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// scure/btc-signer 2.4's Transaction.fromPSBT drops the Ark PSBT fields
// (ConditionWitness, the taptree, cosigner keys) — arkade's own AGENTS.md warns
// about it. A claim decoded that way loses the preimage the F1 harvester
// reads; a proof decoded that way loses the taptree an exit needs. Every PSBT
// we decode must go through the SDK's Transaction subclass.

const ROOTS = ['src', 'subdustd']

// Files allowed to import scure's own Transaction, and why. None may decode a PSBT.
const SCURE_TRANSACTION_ALLOWED: Record<string, string> = {
  'src/exit/dest_verify.ts': 'builds the BIP-322 to_sign tx from raw parts; no PSBT, no Ark fields',
}

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules') return []
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })

const sources = ROOTS.flatMap(files).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

const importsFrom = (text: string, pkg: string): string[] =>
  [...text.matchAll(new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+'${pkg.replace('/', '\\/')}'`, 'g'))].flatMap((m) =>
    m[1]!.split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!),
  )

describe('PSBT decoding goes through the SDK Transaction', () => {
  test('the audit actually sees the codebase', () => {
    expect(sources.length).toBeGreaterThan(50)
    expect(sources.some((s) => s.text.includes('fromPSBT('))).toBe(true)
  })

  test("every file that calls fromPSBT imports Transaction from '@arkade-os/sdk'", () => {
    const offenders = sources
      .filter((s) => s.text.includes('fromPSBT('))
      .filter((s) => !importsFrom(s.text, '@arkade-os/sdk').includes('Transaction'))
      .map((s) => s.path)
    expect(offenders).toEqual([])
  })

  test("scure's Transaction is imported only where allowlisted, and never next to fromPSBT", () => {
    const scureUsers = sources.filter((s) => importsFrom(s.text, '@scure/btc-signer').includes('Transaction'))
    expect(scureUsers.map((s) => s.path).sort()).toEqual(Object.keys(SCURE_TRANSACTION_ALLOWED).sort())
    expect(scureUsers.filter((s) => s.text.includes('fromPSBT(')).map((s) => s.path)).toEqual([])
  })
})
