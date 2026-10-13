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
import type { Lockout } from '~/ports/lockout'
import type { RateLimiter } from '~/ports/rate-limiter'
import { createTestDeps, type TestDeps } from '~/testing'
import { followFixedClock } from '~/testing/clock-aging'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'

/** The counter adapters, made to wait for the fixed clock's advances to reach the table first. */
function settled(
  options: ReturnType<typeof counterOptions>,
  settle: () => Promise<void>
): { lockout: Lockout; rateLimiter: RateLimiter } {
  const lockout = createPostgresLockout(options)
  const limiter = createPostgresRateLimiter(options)
  return {
    lockout: {
      attempt: async (key, policy, now) => {
        await settle()
        return lockout.attempt(key, policy, now)
      },
      clear: async (key) => {
        await settle()
        return lockout.clear(key)
      },
    },
    rateLimiter: {
      hit: async (key, limit, windowMs) => {
        await settle()
        return limiter.hit(key, limit, windowMs)
      },
    },
  }
}

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
export function secondInstance(
  deps: TestDeps & { db: Database; settle: () => Promise<void> }
): TestDeps {
  return { ...deps, ...settled(counterOptions(deps, deps.db), deps.settle) }
}

/** Test deps whose stores are the real Postgres adapters; the outside world stays in memory. */
export async function createPostgresDeps(): Promise<
  TestDeps & { stop: () => Promise<void>; db: Database; settle: () => Promise<void> }
> {
  await migrate()
  const owner = ownerPool()
  await resetAuthData(owner)
  const memory = createTestDeps()
  // The counters follow the database clock, the tests the fixed one: what the fixed clock
  // advances is applied to the stored times, as the owner (the service role cannot rewrite them).
  const settle = followFixedClock(memory.clock, (text, seconds) => owner.query(text, [seconds]))
  const handle = createDb(authUrl(), { max: memory.env.DB_POOL_MAX })
  const deps = Object.assign(memory, {
    fixedProject: createPostgresFixedProject(handle.db),
    signingKeys: createPostgresSigningKeyStore(handle.db),
    users: new PostgresUserRepository(handle.db),
    flowAttempts: new PostgresFlowAttemptStore(handle.db),
    verificationTokens: new PostgresVerificationTokenStore(handle.db),
    sessions: new PostgresSessionStore(handle.db),
    exclusive: createPostgresExclusiveRunner(handle.db),
    ...settled(counterOptions(memory, handle.db), settle),
    counterPurger: createPostgresCounterPurger(handle.db),
    settle,
    stop: async () => {
      await handle.close()
      await owner.end()
    },
    db: handle.db,
  })
  await Bootstrap.start(deps)
  return deps
}
