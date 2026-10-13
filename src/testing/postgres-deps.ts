import { createDb, type Database } from 'tula-closeline-db'
import {
  createPostgresCounterPurger,
  createPostgresLockout,
  createPostgresRateLimiter,
} from '~/adapters/postgres/counters'
import { createPostgresExclusiveRunner } from '~/adapters/postgres/exclusive-runner'
import { createPostgresFixedProject } from '~/adapters/postgres/fixed-project'
import { PostgresFlowAttemptStore } from '~/adapters/postgres/flow-attempts'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { createPostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { counterHashKey } from '~/env'
import * as Bootstrap from '~/modules/bootstrap/service'
import { createTestDeps, type TestDeps } from '~/testing'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'

/** What the Postgres counter adapters of a test instance are built from. */
function counterOptions(deps: TestDeps, db: Database) {
  return {
    db,
    key: counterHashKey(deps.env),
    environmentId: () => deps.tenant.current?.environmentId ?? '',
  }
}

/**
 * A second API instance over the same database: its own counter adapters (so nothing is shared
 * in process memory), the same stores and tenant. `deps` is left as it is.
 */
export function secondInstance(deps: TestDeps & { db: Database }): TestDeps {
  const options = counterOptions(deps, deps.db)
  return {
    ...deps,
    lockout: createPostgresLockout(options),
    rateLimiter: createPostgresRateLimiter(options),
  }
}

/** Test deps whose stores are the real Postgres adapters; the outside world stays in memory. */
export async function createPostgresDeps(): Promise<
  TestDeps & { stop: () => Promise<void>; db: Database }
> {
  await migrate()
  const owner = ownerPool()
  await resetAuthData(owner)
  await owner.end()
  const memory = createTestDeps()
  const handle = createDb(authUrl(), { max: memory.env.DB_POOL_MAX })
  const deps = Object.assign(memory, {
    fixedProject: createPostgresFixedProject(handle.db),
    signingKeys: createPostgresSigningKeyStore(handle.db),
    users: new PostgresUserRepository(handle.db),
    flowAttempts: new PostgresFlowAttemptStore(handle.db),
    verificationTokens: new PostgresVerificationTokenStore(handle.db),
    sessions: new PostgresSessionStore(handle.db),
    exclusive: createPostgresExclusiveRunner(handle.db),
    lockout: createPostgresLockout(counterOptions(memory, handle.db)),
    rateLimiter: createPostgresRateLimiter(counterOptions(memory, handle.db)),
    counterPurger: createPostgresCounterPurger(handle.db),
    stop: handle.close,
    db: handle.db,
  })
  await Bootstrap.start(deps)
  return deps
}
