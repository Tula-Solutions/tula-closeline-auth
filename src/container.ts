import { sql } from 'drizzle-orm'
import type { RequestId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import {
  type Clock,
  createLogger,
  type LogDestination,
  type Logger,
  systemClock,
} from 'tula-closeline-kit'
import { HibpBreachChecker } from '~/adapters/breach/hibp'
import { createGoogleProvider } from '~/adapters/http/google'
import { createHttpMembership } from '~/adapters/http/membership'
import { createMailpitMailer, DEFAULT_LOCAL_MAIL_FROM } from '~/adapters/mailpit/mailer'
import { createPlaceholderMembership } from '~/adapters/placeholder/membership'
import { createPostgresAbandonCases } from '~/adapters/postgres/abandon-cases'
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
import { uuidV7Ids } from '~/adapters/system/ids'
import { createUnconfiguredMailer } from '~/adapters/unconfigured/mailer'
import { createUnconfiguredOidcProvider } from '~/adapters/unconfigured/oidc-provider'
import { describeError } from '~/describe-error'
import { counterHashKey, databaseUrl, type Env, googleConfig, loadEnv, masterKey } from '~/env'
import { SERVICE } from '~/info'
import { createWorkLimits, type WorkLimits } from '~/lib/concurrency'
import { createKeyedHash, type KeyedHash } from '~/lib/keyed-hash'
import { createSecretBox, type SecretBox } from '~/lib/secret-box'
import type { AbandonCaseStore } from '~/ports/abandon-cases'
import type { BreachChecker } from '~/ports/breach-checker'
import type { CounterPurger } from '~/ports/counter-purger'
import type { ExclusiveRunner } from '~/ports/exclusive-runner'
import type { FixedProject, Tenant } from '~/ports/fixed-project'
import type { FlowAttemptStore } from '~/ports/flow-attempt-store'
import type { IdGenerator } from '~/ports/id-generator'
import type { Lockout } from '~/ports/lockout'
import type { Mailer } from '~/ports/mailer'
import type { MembershipClaims } from '~/ports/membership'
import type { OidcProvider } from '~/ports/oidc-provider'
import type { RateLimiter } from '~/ports/rate-limiter'
import type { SessionStore } from '~/ports/session-store'
import type { SigningKeyStore } from '~/ports/signing-key-store'
import type { UserRepository } from '~/ports/user-repository'
import type { VerificationTokenStore } from '~/ports/verification-token-store'

/** One dependency probe for `/readyz`: resolve when healthy, reject or stall when not. */
export type ReadinessCheck = {
  /** A short stable name, reported to the caller, never an address or credential. */
  name: string
  /** Probes the dependency; `signal` aborts when the check has run out of time. */
  run: (signal: AbortSignal) => Promise<void>
}

/** What `reportError` is told about the request that failed. */
export type ErrorContext = {
  requestId: RequestId
  method: string
  /** The path only, never the query string, which can carry secrets. */
  path: string
  /** The HTTP status of the response sent to the client, which can differ from the error's own. */
  status: number
}

/** Everything a request needs from outside the process, built once in {@link createContainer}. */
export type Container = {
  env: Env
  logger: Logger
  clock: Clock
  /** Probes run by `/readyz`; empty until the service gains a dependency. */
  readinessChecks: readonly ReadinessCheck[]
  /**
   * The one place unexpected errors go. It logs through the kit logger today; the error tracker is
   * wired in here and nowhere else. It must not throw and must not return anything to a client.
   */
  reportError: (error: unknown, context: ErrorContext) => void
  /**
   * Set once shutdown begins: `/readyz` answers 503 from then on, before the server stops.
   * `drainingSince` is when the first signal arrived (epoch ms from `clock`), for shutdown only.
   */
  lifecycle: { draining: boolean; drainingSince?: number }
  /** Mints row ids. */
  ids: IdGenerator
  /** The Region's one workspace and project; only `modules/bootstrap` calls it. */
  fixedProject: FixedProject
  /** The tenant this deployment serves, set once bootstrapping has run. */
  tenant: { current?: Tenant }
  /** Signing keys, sealed with the master key. */
  signingKeys: SigningKeyStore
  /** Seals secrets at rest with keys derived from `AUTH_MASTER_KEY`. */
  secretBox: SecretBox
  /** HMACs for low-entropy secrets and derived tokens, keyed from `AUTH_MASTER_KEY`. */
  keyedHash: KeyedHash
  /** Organization and role for a token, from the core service. */
  membership: MembershipClaims
  /** Users with their email identity and password. */
  users: UserRepository
  /** Open sign-up and sign-in attempts. */
  flowAttempts: FlowAttemptStore
  /** Emailed verification codes. */
  verificationTokens: VerificationTokenStore
  /** Sessions and their refresh tokens. */
  sessions: SessionStore
  /** Sends the verification emails. */
  mailer: Mailer
  /** The OpenID provider behind Sign in with Google (ADR 0019); unconfigured when it is off. */
  oidc: OidcProvider
  /** Per-key request limits, counted in Postgres so every instance shares them (ADR 0014). */
  rateLimiter: RateLimiter
  /** Backs off repeated wrong passwords per address and per known device, counted in Postgres. */
  lockout: Lockout
  /** Organizations core made for sign-ups whose account may never be written (hub issue 36). */
  abandonCases: AbandonCaseStore
  /** Removes expired lockout and rate-limit counters, in bounded batches. */
  counterPurger: CounterPurger
  /** Lets work that must not run on two instances at once take turns (the purge). */
  exclusive: ExclusiveRunner
  /** Bounds on password hashing and the breach lookup, so one instance cannot be flooded. */
  limits: WorkLimits
  /** Whether a password appears in known breaches. */
  breachChecker: BreachChecker
  /** Releases what the container holds (connections to core and the database); call once on shutdown. */
  close: () => Promise<void>
}

/**
 * Calls `reportError` so that it can neither throw nor leave a rejected promise behind, even if
 * an implementation wrongly went async.
 */
export function reportSafely(
  container: Pick<Container, 'reportError'>,
  error: unknown,
  context: ErrorContext
): void {
  try {
    const result: unknown = container.reportError(error, context)
    if (result instanceof Promise) {
      result.catch(() => {})
    }
  } catch {
    // A failing reporter must never turn a handled error into a dropped response.
  }
}

/** Options for {@link createContainer}. */
export type ContainerOptions = {
  /** Where log lines go; defaults to stdout. */
  logDestination?: LogDestination
}

/**
 * Chooses the membership adapter: the HTTP one when core is configured. Only `local` may run
 * without it (on the placeholder, which never invents a membership); anywhere else a missing
 * configuration is an error here as well as in {@link loadEnv}, so the placeholder can never
 * serve a real deployment.
 */
export function createMembership(env: Env, logger: Pick<Logger, 'warn'>): MembershipClaims {
  if (env.CORE_BASE_URL !== undefined && env.CORE_INTERNAL_TOKEN !== undefined) {
    return createHttpMembership({
      baseUrl: env.CORE_BASE_URL,
      token: env.CORE_INTERNAL_TOKEN,
      environment: env.ENVIRONMENT,
      logger,
      concurrency: env.CORE_CONCURRENCY,
      queue: env.CORE_QUEUE,
      // Refresh and sign-in each look the user up, so reuse the connection to core: no TCP or TLS
      // handshake per lookup (hub issue 45). Closed with the container.
      keepAlive: true,
    })
  }
  if (env.ENVIRONMENT === 'local') {
    return createPlaceholderMembership()
  }
  throw new Error('CORE_BASE_URL and CORE_INTERNAL_TOKEN are required outside local')
}

/**
 * Chooses the mailer: the local mailbox adapter when `MAIL_LOCAL_URL` is set, otherwise the
 * unconfigured one, which fails every send with `mail.unavailable`. The local adapter is built
 * only when `ENVIRONMENT` is `local`: with the URL set anywhere else this throws, as {@link loadEnv}
 * does, instead of trusting that it ran or falling back. The production provider is still
 * undecided (hub issue #35).
 */
export function createMailer(env: Env, logger: Pick<Logger, 'warn'>): Mailer {
  if (env.MAIL_LOCAL_URL === undefined) {
    return createUnconfiguredMailer()
  }
  if (env.ENVIRONMENT !== 'local') {
    throw new Error('MAIL_LOCAL_URL is accepted only when ENVIRONMENT is local')
  }
  return createMailpitMailer({
    baseUrl: env.MAIL_LOCAL_URL,
    from: env.MAIL_LOCAL_FROM ?? DEFAULT_LOCAL_MAIL_FROM,
    logger,
  })
}

/**
 * Chooses the OpenID provider: Google (or, in `local` only, the issuer `GOOGLE_ISSUER_URL` names)
 * when the three `GOOGLE_` settings are set, otherwise the unconfigured one, which answers
 * `oidc.disabled`. The client secret is passed to the adapter and nowhere else.
 */
export function createOidcProvider(
  env: Env,
  clock: Clock,
  logger: Pick<Logger, 'warn'>
): OidcProvider {
  const config = googleConfig(env)
  return config === undefined
    ? createUnconfiguredOidcProvider()
    : createGoogleProvider({ ...config, clock, logger })
}

/** The single composition root: the only place adapters and process-wide objects are constructed. */
export function createContainer(env: Env = loadEnv(), options: ContainerOptions = {}): Container {
  const logger = createLogger({
    service: SERVICE,
    level: env.LOG_LEVEL,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  })

  // The pool connects on first use, so building a container needs no database.
  const database = createDb(databaseUrl(env), {
    max: env.DB_POOL_MAX,
    onError: (error) => logger.error('database connection error', { error: describeError(error) }),
  })
  const tenant: Container['tenant'] = {}
  // The counters are hashed with their own key; the environment is known once bootstrapping ran.
  const counters = {
    db: database.db,
    key: counterHashKey(env),
    environmentId: () => {
      if (!tenant.current) {
        throw new Error('the fixed project is not bootstrapped')
      }
      return tenant.current.environmentId
    },
  }

  const membership = createMembership(env, logger)

  return {
    env,
    logger,
    clock: systemClock,
    readinessChecks: [
      {
        name: 'database',
        run: async () => {
          await database.db.execute(sql`select 1`)
        },
      },
      {
        name: 'bootstrap',
        run: async () => {
          if (!tenant.current) {
            throw new Error('the fixed project is not bootstrapped')
          }
        },
      },
    ],
    lifecycle: { draining: false },
    ids: uuidV7Ids,
    fixedProject: createPostgresFixedProject(database.db),
    tenant,
    signingKeys: createPostgresSigningKeyStore(database.db),
    secretBox: createSecretBox(masterKey(env)),
    keyedHash: createKeyedHash(masterKey(env)),
    membership,
    users: new PostgresUserRepository(database.db),
    flowAttempts: new PostgresFlowAttemptStore(database.db),
    verificationTokens: new PostgresVerificationTokenStore(database.db),
    sessions: new PostgresSessionStore(database.db),
    // The production mail provider is still undecided (hub issue #35): outside a local mailbox,
    // sending fails with `mail.unavailable`.
    mailer: createMailer(env, logger),
    oidc: createOidcProvider(env, systemClock, logger),
    rateLimiter: createPostgresRateLimiter(counters),
    lockout: createPostgresLockout(counters),
    abandonCases: createPostgresAbandonCases(database.db),
    counterPurger: createPostgresCounterPurger(database.db),
    exclusive: createPostgresExclusiveRunner(database.db),
    limits: createWorkLimits(env),
    breachChecker: new HibpBreachChecker({ logger }),
    close: async () => {
      // Kept connections to core first, so the process can exit; then the database pool.
      membership.close?.()
      await database.close()
    },
    reportError: (error, context) => {
      logger.error('unhandled error', { ...context, error: describeError(error) })
    },
  }
}
