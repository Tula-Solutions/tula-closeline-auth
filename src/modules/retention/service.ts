import { type Container, reportSafely } from '~/container'
import { describeError } from '~/describe-error'
import { resolveRequestId } from '~/http/request-id'
import { withTimeout } from '~/lib/timeout'
import { MEMBERSHIP_TIMEOUT_MS } from '~/modules/membership/service'
import type { Tenant } from '~/ports/fixed-project'

/** The name instances take turns on, so only one purges at a time. */
export const RETENTION_LOCK = 'retention'

/** What retention needs from the container. */
export type RetentionDeps = Pick<
  Container,
  | 'env'
  | 'clock'
  | 'logger'
  | 'flowAttempts'
  | 'verificationTokens'
  | 'counterPurger'
  | 'exclusive'
  | 'reportError'
>

/**
 * How long past its expiry an attempt or code is kept: twice the time core is given to answer.
 * A sign-up that checked its code just before expiry is still waiting on core and writes its
 * account and spends the code afterwards, so a purge that ran in between would turn a sign-up
 * that worked into a 409. The second timeout is slack for the writes that follow core's answer.
 */
export const PURGE_GRACE_MS = 2 * MEMBERSHIP_TIMEOUT_MS

/** How many rows one purge removed, by kind. */
export type PurgeResult = { attempts: number; tokens: number; counters: number }

/** How a run ended: it purged, another instance held the lock, it failed, or it ran out of time. */
export type RunOutcome = 'purged' | 'skipped' | 'failed' | 'timed_out'

/** The thrown value of a run that exceeded its time. */
class RunTimedOut extends Error {
  constructor() {
    super('the retention run timed out')
    this.name = 'RunTimedOut'
  }
}

function graceBefore(now: Date): Date {
  return new Date(now.getTime() - PURGE_GRACE_MS)
}

/** Tells the error tracker a run failed; the error carries no row data, only that it failed. */
function reportFailure(deps: RetentionDeps, what: string, cause: unknown): void {
  reportSafely(deps, new Error(`retention run ${what}`, { cause }), {
    requestId: resolveRequestId(undefined),
    method: 'RETENTION',
    path: 'retention',
    status: 500,
  })
}

/**
 * Removes sign-in attempts (and, by cascade, their codes) and then verification codes that have
 * been expired for longer than {@link PURGE_GRACE_MS}, and then expired lockout and rate-limit
 * counters, `RETENTION_BATCH_SIZE` rows per statement, repeating while a batch comes back full, so
 * no statement holds locks for long however large the backlog. Stops between batches when
 * `signal` aborts.
 */
export async function purgeExpired(
  deps: RetentionDeps,
  tenant: Tenant,
  signal: AbortSignal = new AbortController().signal
): Promise<PurgeResult> {
  const limit = deps.env.RETENTION_BATCH_SIZE
  const total: PurgeResult = { attempts: 0, tokens: 0, counters: 0 }
  const sweeps = [
    {
      key: 'attempts',
      delete: (now: Date) =>
        deps.flowAttempts.deleteExpired(tenant.environmentId, graceBefore(now), limit),
    },
    {
      key: 'tokens',
      delete: (now: Date) =>
        deps.verificationTokens.deleteExpired(tenant.environmentId, graceBefore(now), limit),
    },
    {
      // Lockout and rate-limit counters, across environments (the db library's purge, a minute
      // behind the database clock).
      key: 'counters',
      delete: () => deps.counterPurger.deleteExpired(limit),
    },
  ] as const
  for (const sweep of sweeps) {
    for (;;) {
      if (signal.aborted) {
        return total
      }
      const removed = await sweep.delete(deps.clock.now())
      total[sweep.key] += removed
      if (removed < limit) {
        break
      }
    }
  }
  return total
}

/**
 * One scheduled run: takes the cross-instance lock, purges, and gives up after
 * `RETENTION_RUN_TIMEOUT_MS`. It never throws; a failure is logged and reported (without row data)
 * and the next interval tries again.
 */
export async function runOnce(
  deps: RetentionDeps,
  tenant: Tenant,
  signal?: AbortSignal
): Promise<RunOutcome> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop)
  try {
    let purged: PurgeResult = { attempts: 0, tokens: 0, counters: 0 }
    const ran = await withTimeout(
      deps.exclusive.runExclusive(RETENTION_LOCK, async () => {
        purged = await purgeExpired(deps, tenant, controller.signal)
      }),
      deps.env.RETENTION_RUN_TIMEOUT_MS,
      () => new RunTimedOut()
    )
    if (ran && (purged.attempts > 0 || purged.tokens > 0 || purged.counters > 0)) {
      deps.logger.info('purged expired sign-in data', purged)
    }
    return ran ? 'purged' : 'skipped'
  } catch (error) {
    const timedOut = error instanceof RunTimedOut
    deps.logger.error(timedOut ? 'retention run timed out' : 'retention run failed', {
      ...(timedOut ? {} : { error: describeError(error) }),
    })
    reportFailure(deps, timedOut ? 'timed out' : 'failed', timedOut ? undefined : error)
    return timedOut ? 'timed_out' : 'failed'
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', stop)
  }
}

/** A running schedule. */
export type Retention = {
  /** Stops scheduling, asks a run in progress to stop, and resolves once it has. */
  stop: () => Promise<void>
}

/**
 * Purges at boot and then every `RETENTION_INTERVAL_MS` until stopped. The first run starts at
 * once but is not awaited, so boot is never held up by a backlog.
 */
export function start(deps: RetentionDeps, tenant: Tenant): Retention {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const loop = async (): Promise<void> => {
    await runOnce(deps, tenant, controller.signal)
    if (!controller.signal.aborted) {
      timer = setTimeout(() => {
        current = loop()
      }, deps.env.RETENTION_INTERVAL_MS)
    }
  }
  let current = loop()
  return {
    async stop() {
      controller.abort()
      clearTimeout(timer)
      await current
    },
  }
}
