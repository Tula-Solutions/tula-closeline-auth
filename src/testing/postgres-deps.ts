import { createDb, type Database } from 'tula-closeline-db'
import { createPostgresFixedProject } from '~/adapters/postgres/fixed-project'
import { PostgresFlowAttemptStore } from '~/adapters/postgres/flow-attempts'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { createPostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import * as Bootstrap from '~/modules/bootstrap/service'
import { createTestDeps, type TestDeps } from '~/testing'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'

/** Test deps whose stores are the real Postgres adapters; the outside world stays in memory. */
export async function createPostgresDeps(): Promise<
  TestDeps & { stop: () => Promise<void>; db: Database }
> {
  await migrate()
  const owner = ownerPool()
  await resetAuthData(owner)
  await owner.end()
  const handle = createDb(authUrl())
  const memory = createTestDeps()
  const deps = Object.assign(memory, {
    fixedProject: createPostgresFixedProject(handle.db),
    signingKeys: createPostgresSigningKeyStore(handle.db),
    users: new PostgresUserRepository(handle.db),
    flowAttempts: new PostgresFlowAttemptStore(handle.db),
    verificationTokens: new PostgresVerificationTokenStore(handle.db),
    sessions: new PostgresSessionStore(handle.db),
    stop: handle.close,
    db: handle.db,
  })
  await Bootstrap.start(deps)
  return deps
}
