import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { createPostgresFixedProject } from '~/adapters/postgres/fixed-project'
import { createPostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { uuidV7Ids } from '~/adapters/system/ids'
import { createKeyedHash } from '~/lib/keyed-hash'
import { createSecretBox } from '~/lib/secret-box'
import * as Jwks from '~/modules/jwks/service'
import { createTestDeps } from '~/testing'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'

const owner = ownerPool()
const handle = createDb(authUrl())

beforeAll(migrate)
afterAll(async () => {
  await handle.close()
  await owner.end()
})

test('instances starting together against Postgres end up with one active and one next key', async () => {
  await resetAuthData(owner)
  const base = createTestDeps()
  const deps = {
    ...base,
    ids: uuidV7Ids,
    signingKeys: createPostgresSigningKeyStore(handle.db),
    secretBox: createSecretBox('ab'.repeat(32)),
    keyedHash: createKeyedHash('ab'.repeat(32)),
  }
  const id = () => crypto.randomUUID()
  const tenant = await createPostgresFixedProject(handle.db).ensure(
    'development',
    { workspace: id(), project: id(), development: id(), production: id() },
    new Date()
  )

  await Promise.all(Array.from({ length: 8 }, () => Jwks.ensureAtBoot(deps, tenant)))

  const stored = await deps.signingKeys.list(tenant.environmentId)
  expect(stored.map((key) => key.status).sort()).toEqual(['active', 'next'])
  expect((await Jwks.publicKeySet(deps, tenant)).keys).toHaveLength(2)
})

test('with 50 retired keys, signing reads one row and the published set stays bounded', async () => {
  await resetAuthData(owner)
  const base = createTestDeps()
  const store = createPostgresSigningKeyStore(handle.db)
  const listed: number[] = []
  const deps = {
    ...base,
    ids: uuidV7Ids,
    signingKeys: {
      ...store,
      list: async (environmentId: string) => {
        const records = await store.list(environmentId)
        listed.push(records.length)
        return records
      },
    },
    secretBox: createSecretBox('ab'.repeat(32)),
    keyedHash: createKeyedHash('ab'.repeat(32)),
  }
  const id = () => crypto.randomUUID()
  const tenant = await createPostgresFixedProject(handle.db).ensure(
    'development',
    { workspace: id(), project: id(), development: id(), production: id() },
    new Date()
  )
  await Jwks.ensureKeys(deps, tenant)
  for (let i = 0; i < 50; i++) {
    base.clock.advance('10m')
    await Jwks.rotate(deps, tenant)
  }
  listed.length = 0

  const active = await store.active(tenant.environmentId)
  await Jwks.activeSigningKey(deps, tenant)
  const published = await Jwks.publicKeySet(deps, tenant)

  expect(active?.status).toBe('active')
  expect(listed).toEqual([])
  expect(published.keys.length).toBeLessThanOrEqual(5)
})
