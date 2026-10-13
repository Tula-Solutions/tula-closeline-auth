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
import { createPostgresFixedProject } from '~/adapters/postgres/fixed-project'
import { uuidV7Ids } from '~/adapters/system/ids'
import { describeError } from '~/describe-error'
import { databaseUrl, type Env, loadEnv } from '~/env'
import { SERVICE } from '~/info'
import type { FixedProject, Tenant } from '~/ports/fixed-project'
import type { IdGenerator } from '~/ports/id-generator'

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
  /** Releases what the container holds (database connections); call once on shutdown. */
  close: () => Promise<void>
}

/**
 * Calls `reportError` so that it can neither throw nor leave a rejected promise behind, even if
 * an implementation wrongly went async.
 */
export function reportSafely(container: Container, error: unknown, context: ErrorContext): void {
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

/** The single composition root: the only place adapters and process-wide objects are constructed. */
export function createContainer(env: Env = loadEnv(), options: ContainerOptions = {}): Container {
  const logger = createLogger({
    service: SERVICE,
    level: env.LOG_LEVEL,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  })

  // The pool connects on first use, so building a container needs no database.
  const database = createDb(databaseUrl(env), {
    onError: (error) => logger.error('database connection error', { error: describeError(error) }),
  })
  const tenant: Container['tenant'] = {}

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
    close: database.close,
    reportError: (error, context) => {
      logger.error('unhandled error', { ...context, error: describeError(error) })
    },
  }
}
