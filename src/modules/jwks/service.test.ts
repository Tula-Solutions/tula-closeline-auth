import { describe, expect, test } from 'bun:test'
import { createSecretBox } from '~/lib/secret-box'
import * as Bootstrap from '~/modules/bootstrap/service'
import { createReadyDeps } from '~/testing'
import * as Jwks from './service'

async function setup() {
  const deps = await createReadyDeps()
  return { deps, tenant: Bootstrap.requireTenant(deps) }
}

describe('signing keys', () => {
  test('the first use creates one active and one next key, and publishes both', async () => {
    const { deps, tenant } = await setup()

    const set = await Jwks.publicKeySet(deps, tenant)
    const stored = await deps.signingKeys.list(tenant.environmentId)

    expect(stored.map((key) => key.status).sort()).toEqual(['active', 'next'])
    expect(set.keys.map((key) => key.kid).sort()).toEqual(stored.map((key) => key.id).sort())
  })

  test('the published set holds public parameters only and the stored key is sealed', async () => {
    const { deps, tenant } = await setup()

    const set = await Jwks.publicKeySet(deps, tenant)
    const stored = await deps.signingKeys.list(tenant.environmentId)

    for (const key of set.keys) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x'])
    }
    for (const key of stored) {
      expect(key.privateKeyCiphertext.startsWith('v1.')).toBe(true)
    }
  })

  test('instances racing to create keys end up with exactly one pair', async () => {
    const { deps, tenant } = await setup()

    await Promise.all(Array.from({ length: 8 }, () => Jwks.ensureKeys(deps, tenant)))

    expect(await deps.signingKeys.list(tenant.environmentId)).toHaveLength(2)
  })

  test('a ciphertext copied onto another key does not open', async () => {
    const { deps, tenant } = await setup()
    await Jwks.ensureKeys(deps, tenant)
    const [first, second] = await deps.signingKeys.list(tenant.environmentId)

    const opened = deps.secretBox.open(
      Jwks.SECRET_BOX_PURPOSE,
      first?.privateKeyCiphertext ?? '',
      Jwks.ciphertextAad(second?.id ?? '', tenant.environmentId)
    )

    await expect(opened).rejects.toThrow()
  })

  test('a master key that does not match the stored keys is caught at boot', async () => {
    const { deps, tenant } = await setup()
    await Jwks.ensureKeys(deps, tenant)

    const other = { ...deps, secretBox: createSecretBox('cd'.repeat(32)) }

    await expect(Jwks.ensureAtBoot(other, tenant)).rejects.toThrow()
  })
})

describe('rotation', () => {
  test('is refused until the next key has been published for ten minutes', async () => {
    const { deps, tenant } = await setup()
    await Jwks.ensureKeys(deps, tenant)
    deps.clock.advance('599s')

    const refused = Jwks.rotate(deps, tenant)

    await expect(refused).rejects.toBeInstanceOf(Jwks.RotationRefused)
    await expect(refused).rejects.toMatchObject({ retryAfterSeconds: 1 })
    expect(
      (await deps.signingKeys.list(tenant.environmentId)).map((key) => key.status).sort()
    ).toEqual(['active', 'next'])
  })

  test('activates the published next key, retires the old one and publishes a new next', async () => {
    const { deps, tenant } = await setup()
    await Jwks.ensureKeys(deps, tenant)
    const before = await deps.signingKeys.list(tenant.environmentId)
    const nextBefore = before.find((key) => key.status === 'next')
    deps.clock.advance('10m')

    await Jwks.rotate(deps, tenant)

    const after = await deps.signingKeys.list(tenant.environmentId)
    expect(after.find((key) => key.status === 'active')?.id).toBe(nextBefore?.id ?? '')
    expect(after.map((key) => key.status).sort()).toEqual(['active', 'next', 'retired'])
    expect((await Jwks.publicKeySet(deps, tenant)).keys).toHaveLength(3)
  })

  test('a token signed before a rotation is still verifiable for a while, and not forever', async () => {
    const { deps, tenant } = await setup()
    await Jwks.ensureKeys(deps, tenant)
    deps.clock.advance('10m')
    await Jwks.rotate(deps, tenant)
    const retired = (await deps.signingKeys.list(tenant.environmentId)).find(
      (key) => key.status === 'retired'
    )

    deps.clock.advance('29m')
    expect((await Jwks.publicKeySet(deps, tenant)).keys.map((key) => key.kid)).toContain(
      retired?.id ?? ''
    )
    deps.clock.advance('1m')

    expect((await Jwks.publicKeySet(deps, tenant)).keys.map((key) => key.kid)).not.toContain(
      retired?.id ?? ''
    )
  })

  test('the published set never holds more than twenty keys', async () => {
    const { deps, tenant } = await setup()
    await Jwks.ensureKeys(deps, tenant)
    for (let i = 0; i < 25; i++) {
      deps.clock.advance('10m')
      await Jwks.rotate(deps, tenant)
    }

    expect((await Jwks.publicKeySet(deps, tenant)).keys.length).toBeLessThanOrEqual(20)
  })

  test('is refused when another instance rotated first', async () => {
    const { deps, tenant } = await setup()
    await Jwks.ensureKeys(deps, tenant)
    deps.clock.advance('10m')
    const results = await Promise.allSettled([Jwks.rotate(deps, tenant), Jwks.rotate(deps, tenant)])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })
})
