import { createFixedClock, createLogger, type FixedClock } from 'tula-closeline-kit'
import { createMemoryAbandonCases, type MemoryAbandonCases } from '~/adapters/memory/abandon-cases'
import { MemoryBreachChecker } from '~/adapters/memory/breach-checker'
import { createMemoryCounterPurger } from '~/adapters/memory/counter-purger'
import { createMemoryExclusiveRunner } from '~/adapters/memory/exclusive-runner'
import { createMemoryFixedProject } from '~/adapters/memory/fixed-project'
import { MemoryFlowAttemptStore } from '~/adapters/memory/flow-attempts'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { MemoryMailer } from '~/adapters/memory/mailer'
import { createMemoryMembership, type MemoryMembership } from '~/adapters/memory/membership'
import { createMemoryOidcProvider, type MemoryOidcProvider } from '~/adapters/memory/oidc-provider'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemorySessionStore } from '~/adapters/memory/sessions'
import { createMemorySigningKeyStore } from '~/adapters/memory/signing-keys'
import { MemoryUserRepository } from '~/adapters/memory/users'
import { MemoryVerificationTokenStore } from '~/adapters/memory/verification-tokens'
import { uuidV7Ids } from '~/adapters/system/ids'
import type { Container, ErrorContext, ReadinessCheck } from '~/container'
import { loadEnv, masterKey } from '~/env'
import { SERVICE } from '~/info'
import { createWorkLimits } from '~/lib/concurrency'
import { createKeyedHash } from '~/lib/keyed-hash'
import { createSecretBox } from '~/lib/secret-box'
import * as Bootstrap from '~/modules/bootstrap/service'

/** The container plus the observable side effects a test asserts on. */
export type TestDeps = Container & {
  clock: FixedClock
  /** Every JSON log line written, in order. */
  logLines: string[]
  /** Every call to `reportError`, in order. */
  reported: { error: unknown; context: ErrorContext }[]
  /** The memory membership service, with the controls to arrange and break it. */
  membership: MemoryMembership
  /** The abandon cases, with a control to make one due. */
  abandonCases: MemoryAbandonCases
  /** The user repository, with a control to ban a user. */
  users: MemoryUserRepository
  /** The mailer that keeps what it was asked to send. */
  mailer: MemoryMailer
  /** The breach checker, with the passwords it should call breached. */
  breachChecker: MemoryBreachChecker
  /** The OpenID provider: a fake Google behind the real adapter, with controls. */
  oidc: MemoryOidcProvider
}

/** Builds a container of in-memory doubles and a fixed clock; `overrides` replace any field. */
export function createTestDeps(
  overrides: {
    readinessChecks?: readonly ReadinessCheck[]
    env?: Record<string, string>
    /** Passwords the breach checker calls breached. */
    breached?: string[]
  } = {}
): TestDeps {
  const logLines: string[] = []
  const reported: TestDeps['reported'] = []
  const env = loadEnv({
    ENVIRONMENT: 'local',
    REGION: 'eu',
    LOG_LEVEL: 'debug',
    DATABASE_URL: 'postgres://closeline_auth:unused@127.0.0.1:1/closeline',
    AUTH_MASTER_KEY: 'ab'.repeat(32),
    COUNTER_HASH_KEY: 'h'.repeat(40),
    DEVICE_COOKIE_KEY: 'd'.repeat(40),
    PUBLIC_URL: 'https://auth.test.example.com',
    CORE_BASE_URL: 'https://core.test.example.com',
    CORE_INTERNAL_TOKEN: 'test-core-token-0123456789abcdef-test',
    // A deployed environment must name an allowed origin; `local` leaves it unset.
    ...(overrides.env?.ENVIRONMENT !== undefined && overrides.env.ENVIRONMENT !== 'local'
      ? { SESSION_ALLOWED_ORIGINS: 'https://app.example.com', TRUSTED_PROXY_HOPS: '1' }
      : {}),
    ...overrides.env,
  })

  const clock = createFixedClock('2026-01-01T00:00:00Z')
  const abandonCases = createMemoryAbandonCases(clock)
  const flowAttempts = new MemoryFlowAttemptStore()
  return {
    env,
    logger: createLogger({
      service: SERVICE,
      level: 'debug',
      destination: { write: (line) => void logLines.push(line) },
    }),
    clock,
    readinessChecks: overrides.readinessChecks ?? [],
    lifecycle: { draining: false },
    ids: uuidV7Ids,
    fixedProject: createMemoryFixedProject(),
    tenant: {},
    signingKeys: createMemorySigningKeyStore(),
    secretBox: createSecretBox(masterKey(env)),
    keyedHash: createKeyedHash(masterKey(env)),
    membership: createMemoryMembership(clock),
    abandonCases,
    users: new MemoryUserRepository(
      (environmentId, caseId) => abandonCases.settle(environmentId, caseId),
      flowAttempts
    ),
    flowAttempts,
    verificationTokens: new MemoryVerificationTokenStore(),
    sessions: new MemorySessionStore(),
    mailer: new MemoryMailer(),
    oidc: createMemoryOidcProvider(clock),
    rateLimiter: new MemoryRateLimiter(clock),
    lockout: new MemoryLockout(clock),
    counterPurger: createMemoryCounterPurger(),
    exclusive: createMemoryExclusiveRunner(),
    limits: createWorkLimits(env),
    breachChecker: new MemoryBreachChecker(overrides.breached),
    close: async () => {},
    reportError: (error, context) => {
      reported.push({ error, context })
    },
    logLines,
    reported,
  }
}

/** Like {@link createTestDeps}, with the fixed project already bootstrapped (the normal case). */
export async function createReadyDeps(
  overrides: Parameters<typeof createTestDeps>[0] = {}
): Promise<TestDeps> {
  const deps = createTestDeps(overrides)
  await Bootstrap.start(deps)
  return deps
}
