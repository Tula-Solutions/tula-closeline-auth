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
