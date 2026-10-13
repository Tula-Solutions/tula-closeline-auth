import { formatId, type UserId } from 'tula-closeline-contract'
import { type Container, reportSafely } from '~/container'
import { describeError } from '~/describe-error'
import { resolveRequestId } from '~/http/request-id'
import { withTimeout } from '~/lib/timeout'
import {
  abandon as abandonOrganization,
  isOrganizationDeleted,
  MEMBERSHIP_TIMEOUT_MS,
  of as membershipOf,
} from '~/modules/membership/service'
import type { ClaimedAbandonCase } from '~/ports/abandon-cases'
import type { Tenant } from '~/ports/fixed-project'

/** The name instances take turns on, so only one sweeps at a time (its own, not retention's). */
export const ABANDON_SWEEP_LOCK = 'abandon-sweep'

/**
 * Margin on top of the call bound for clock skew between instances and for the database work
 * around the call. An attempt's expiry is read by one instance's clock and its request may run
 * on another.
 */
export const ABANDON_SKEW_MARGIN_MS = 25_000

/**
 * How long past an attempt's expiry a request that started before it can still commit the
 * account: the 5 s call to core plus {@link ABANDON_SKEW_MARGIN_MS}. Recorded with each case
 * (the table raises anything below its 10 s floor), so the case is not due before it has passed.
 */
export const ABANDON_GRACE_MS = MEMBERSHIP_TIMEOUT_MS + ABANDON_SKEW_MARGIN_MS

/** The most one case can take to settle: a membership lookup then an abandon, each bounded by 5 s. */
export const ABANDON_CASE_BOUND_MS = 2 * MEMBERSHIP_TIMEOUT_MS + 1_000

/**
 * The lease for a batch of `batchSize` cases, which are settled one after another: the last case
 * of a batch must finish inside the lease of the first, or a second sweep would claim it while
 * the first is still calling core.
 */
export function leaseMs(batchSize: number): number {
  return batchSize * ABANDON_CASE_BOUND_MS + ABANDON_SKEW_MARGIN_MS
}

/**
 * The service gives a case up on its claim number past this, well under the table's bound of
 * 100. A failed try is retried one lease later, so this is about as many leases (about an hour
 * and a half at the defaults) of core being down before a person has to look.
 */
export const ABANDON_SWEEP_MAX_ATTEMPTS = 40

/** The most spent cases one run gives up. */
const GIVE_UP_BATCH = 20

/** What the sweep needs from the container. */
export type SweepDeps = Pick<
  Container,
  'env' | 'clock' | 'logger' | 'abandonCases' | 'users' | 'membership' | 'exclusive' | 'reportError'
>

/** How one case ended in one run. */
export type CaseResult =
  | 'account_exists'
  | 'no_organization'
  | 'abandoned'
  | 'refused'
  | 'gave_up'
  | 'retry_later'
  | 'lost_lease'

/** How many cases ended each way in one run, plus the spent ones the safety net gave up. */
export type SweepResult = Record<CaseResult, number> & { spent: number }

function emptyResult(): SweepResult {
  return {
    account_exists: 0,
    no_organization: 0,
    abandoned: 0,
    refused: 0,
    gave_up: 0,
    retry_later: 0,
    lost_lease: 0,
    spent: 0,
  }
}

/** Tells the error tracker, by ids only (never an address or a name), that a person must look. */
function reportCase(deps: SweepDeps, message: string): void {
  reportSafely(deps, new Error(message), {
    requestId: resolveRequestId(undefined),
    method: 'ABANDON',
    path: 'abandon-sweep',
    status: 500,
  })
}

/**
 * Settles one claimed case.
 *
 * **Why abandoning is safe.** The claim only returns a case once the database clock has passed
 * the attempt's expiry plus {@link ABANDON_GRACE_MS}. A request that loaded the attempt before its
 * expiry holds the code for at most the 5 s call to core plus a few database statements, so no
 * request can commit an account for this attempt after that point, and a read that finds none
 * stays true. The read and the call to core are not atomic; this ordering is what makes them
 * safe, and the table's `abandon_cases_due_after_expiry` check stops a case from being due early.
 * Core adds its own guard (one member, the given user, under 24 hours, not suspended).
 *
 * **A case whose Organization id was never learned** (the answer of core was lost in a crash or a
 * timeout) is looked up by its user id with the membership lookup, the one call that finds an
 * Organization by user: none means core made nothing, one is learned and abandoned like any other.
 *
 * Core is called outside any transaction. A 503 or a network failure leaves the case for its next
 * lease; a resolve that finds the case already resolved (a lost lease) is not an error.
 */
async function settle(
  deps: SweepDeps,
  tenant: Tenant,
  claimed: ClaimedAbandonCase
): Promise<CaseResult> {
  const { environmentId } = tenant
  const { id, userId, attemptId } = claimed
  const resolve = (outcome: 'done' | 'not_needed' | 'refused' | 'gave_up') =>
    deps.abandonCases.resolve(environmentId, id, outcome)
  /** Resolves as `done` and says which of the three results it was, ids only. */
  const finish = async (
    result: 'account_exists' | 'no_organization' | 'abandoned',
    org?: string | null
  ) => {
    // `done` only when core removed the Organization; `not_needed` when there was nothing to remove.
    if (!(await resolve(result === 'abandoned' ? 'done' : 'not_needed'))) {
      return 'lost_lease' as const
    }
    deps.logger.info('an abandon case was finished', {
      result,
      caseId: id,
      userId,
      attemptId,
      organizationId: org ?? null,
    })
    return result
  }

  if (claimed.attempts > ABANDON_SWEEP_MAX_ATTEMPTS) {
    if (await resolve('gave_up')) {
      deps.logger.warn('the abandon sweep gave up on a case', {
        caseId: id,
        userId,
        attemptId,
        organizationId: claimed.organizationId,
      })
      reportCase(
        deps,
        `abandon case ${id} (user ${userId}, attempt ${attemptId}, organization ` +
          `${claimed.organizationId ?? 'unknown'}) was given up after ${claimed.attempts} tries; reconcile`
      )
      return 'gave_up'
    }
    return 'lost_lease'
  }

  // An account for this user means the sign-up completed: nothing is owed to core.
  if ((await deps.users.findById(environmentId, userId)) !== null) {
    return finish('account_exists')
  }

  const userUuid = formatId('usr', userId) as UserId
  let organizationId = claimed.organizationId
  if (organizationId === null) {
    let found: Awaited<ReturnType<typeof membershipOf>>
    try {
      found = await membershipOf(deps, userUuid)
    } catch (error) {
      if (isOrganizationDeleted(error)) {
        return finish('no_organization')
      }
      deps.logger.warn('the abandon sweep could not look an Organization up', {
        caseId: id,
        userId,
        attemptId,
      })
      return 'retry_later'
    }
    if (found === null) {
      // Core holds no membership for this user id: it made nothing, or already abandoned it.
      return finish('no_organization')
    }
    organizationId = found.organizationId
    const learned = await deps.abandonCases.learn(environmentId, id, organizationId)
    if (learned === 'conflict') {
      // Another case holds this Organization: this one cannot track it. Report both by ids.
      await resolve('gave_up')
      deps.logger.warn('an abandon case found an Organization another case holds', {
        caseId: id,
        userId,
        attemptId,
        organizationId,
      })
      reportCase(
        deps,
        `abandon case ${id} (user ${userId}, attempt ${attemptId}) found organization ` +
          `${organizationId}, which another case already holds; reconcile`
      )
      return 'gave_up'
    }
  }

  const outcome = await abandonOrganization(deps, {
    organizationId: organizationId as Parameters<typeof abandonOrganization>[1]['organizationId'],
    userId: userUuid,
    idempotencyKey: `abandon:${attemptId}`,
  })
  if (outcome === 'unfinished') {
    return 'retry_later'
  }
  if (outcome === 'refused') {
    if (await resolve('refused')) {
      reportCase(
        deps,
        `core refused to abandon organization ${organizationId}: user ${userId} has no account ` +
          `(attempt ${attemptId}, case ${id}); reconcile`
      )
      return 'refused'
    }
    return 'lost_lease'
  }
  const finished = await finish('abandoned', organizationId)
  if (finished === 'abandoned') {
    deps.logger.warn('an Organization with no owner was abandoned', {
      organizationId,
      userId,
      attemptId,
      caseId: id,
    })
  }
  return finished
}

/**
 * One sweep: claims due cases in bounded batches (a lease, no transaction held across core),
 * gives up spent cases once after the first claim, settles each case, and repeats while a batch
 * comes back full. Stops between cases when `signal` aborts; cases it did not reach come due
 * again when their lease ends. Exported for its tests.
 */
export async function sweep(
  deps: SweepDeps,
  tenant: Tenant,
  signal: AbortSignal = new AbortController().signal
): Promise<SweepResult> {
  const total = emptyResult()
  const batchSize = deps.env.ABANDON_SWEEP_BATCH_SIZE
  let first = true
  for (;;) {
    if (signal.aborted) {
      return total
    }
    const claimed = await deps.abandonCases.claim(
      tenant.environmentId,
      batchSize,
      leaseMs(batchSize)
    )
    if (first) {
      first = false
      const spent = await deps.abandonCases.giveUpSpent(tenant.environmentId, GIVE_UP_BATCH)
      total.spent += spent.length
      for (const id of spent) {
        deps.logger.warn('the abandon sweep gave up on a spent case', { caseId: id })
        reportCase(deps, `abandon case ${id} used every try the table allows; reconcile`)
      }
    }
    for (const one of claimed) {
      if (signal.aborted) {
        return total
      }
      try {
        total[await settle(deps, tenant, one)] += 1
      } catch (error) {
        total.retry_later += 1
        deps.logger.error('the abandon sweep failed on a case', {
          caseId: one.id,
          userId: one.userId,
          attemptId: one.attemptId,
          error: describeError(error),
        })
      }
    }
    if (claimed.length < batchSize) {
      return total
    }
  }
}

/** How a run ended: it swept, another instance held the lock, it failed, or it ran out of time. */
export type RunOutcome = 'swept' | 'skipped' | 'failed' | 'timed_out'

class RunTimedOut extends Error {
  constructor() {
    super('the abandon sweep timed out')
    this.name = 'RunTimedOut'
  }
}

/**
 * One scheduled run under its own advisory lock. It is separate from retention's lock because a
 * sweep calls core (seconds per case) while the purge must stay quick, and a slow core must never
 * hold the purge back or the other way round. Never throws.
 */
export async function runOnce(
  deps: SweepDeps,
  tenant: Tenant,
  signal?: AbortSignal
): Promise<RunOutcome> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop)
  try {
    let result = emptyResult()
    const ran = await withTimeout(
      deps.exclusive.runExclusive(ABANDON_SWEEP_LOCK, async () => {
        result = await sweep(deps, tenant, controller.signal)
      }),
      leaseMs(deps.env.ABANDON_SWEEP_BATCH_SIZE),
      () => new RunTimedOut()
    )
    if (ran && Object.values(result).some((count) => count > 0)) {
      deps.logger.info('swept abandon cases', result)
    }
    return ran ? 'swept' : 'skipped'
  } catch (error) {
    const timedOut = error instanceof RunTimedOut
    deps.logger.error(timedOut ? 'abandon sweep timed out' : 'abandon sweep failed', {
      ...(timedOut ? {} : { error: describeError(error) }),
    })
    reportSafely(
      deps,
      new Error(`abandon sweep ${timedOut ? 'timed out' : 'failed'}`, {
        cause: timedOut ? undefined : error,
      }),
      {
        requestId: resolveRequestId(undefined),
        method: 'ABANDON',
        path: 'abandon-sweep',
        status: 500,
      }
    )
    return timedOut ? 'timed_out' : 'failed'
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', stop)
  }
}

/** A running schedule. */
export type Sweeper = { stop: () => Promise<void> }

/** Sweeps at boot (not awaited) and every `ABANDON_SWEEP_INTERVAL_MS` until stopped. */
export function start(deps: SweepDeps, tenant: Tenant): Sweeper {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const loop = async (): Promise<void> => {
    await runOnce(deps, tenant, controller.signal)
    if (!controller.signal.aborted) {
      timer = setTimeout(() => {
        current = loop()
      }, deps.env.ABANDON_SWEEP_INTERVAL_MS)
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
