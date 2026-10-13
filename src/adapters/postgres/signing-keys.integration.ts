import { afterAll, beforeAll } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { createPostgresFixedProject } from '~/adapters/postgres/fixed-project'
import { createPostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { signingKeyStoreSuite } from '~/adapters/signing-key-store.suite'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'

const owner = ownerPool()
const handle = createDb(authUrl())

beforeAll(migrate)
afterAll(async () => {
  await handle.close()
  await owner.end()
})

signingKeyStoreSuite('postgres', async () => {
  await resetAuthData(owner)
  const id = () => crypto.randomUUID()
  const ids = { workspace: id(), project: id(), development: id(), production: id() }
  const tenant = await createPostgresFixedProject(handle.db).ensure('development', ids, new Date())
  return {
    store: createPostgresSigningKeyStore(handle.db),
    environments: [
      { projectId: tenant.projectId, environmentId: ids.development },
      { projectId: tenant.projectId, environmentId: ids.production },
    ],
  }
})
