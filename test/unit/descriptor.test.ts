import { describe, expect, test } from 'bun:test'
import { descriptorChecksum, withChecksum } from '../../src/lib/descriptor'

// Vectors from Bitcoin Core doc/descriptors.md ("Checksums" section).
describe('descriptorChecksum', () => {
  test('pkh vector', () => {
    expect(
      descriptorChecksum(
        'pkh(02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5)',
      ),
    ).toBe('8fhd9pwu')
  })

  test('wpkh vector', () => {
    expect(
      descriptorChecksum(
        'wpkh(02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9)',
      ),
    ).toBe('8zl0zxma')
  })

  test('sh(multi) vector', () => {
    expect(
      descriptorChecksum(
        'sh(multi(2,022f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01,03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe))',
      ),
    ).toBe('y9zthqta')
  })

  test('withChecksum appends after #', () => {
    expect(
      withChecksum('pkh(02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5)'),
    ).toBe('pkh(02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5)#8fhd9pwu')
  })

  test('rejects characters outside the descriptor charset', () => {
    expect(() => descriptorChecksum('tr(한글)')).toThrow('invalid character')
  })
})
