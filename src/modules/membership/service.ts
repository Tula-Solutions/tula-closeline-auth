import { AUTH_ERRORS, type OrganizationId, type UserId } from 'tula-closeline-contract'
import { isAppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { fail, MembershipFaulted, MembershipOutage } from '~/errors'
import { withTimeout } from '~/lib/timeout'
import {
  type Membership,
  MembershipBusy,
  MembershipFault,
  MembershipNotAbandonable,
  MembershipNotRetryable,
  MembershipRefused,
  MembershipRejected,
} from '~/ports/membership'

/** The longest a call to the core service may take before the caller gives up on it. */
export const MEMBERSHIP_TIMEOUT_MS = 5_000

/** What a membership call needs from the container. */
export type MembershipDeps = Pick<Container, 'membership'>

/** Cancels the call that ran out of time (so the adapter can stop it) and names the failure. */
function timedOut(controller: AbortController): Error {
  controller.abort()
  return new Error('membership timed out')
}

/** Seconds a client is told to wait (`Retry-After`) when core could not answer. */
export { MEMBERSHIP_RETRY_AFTER_SECONDS } from '~/errors'

/**
 * The error a membership call that did not answer in time or failed turns into (503 with
 * `Retry-After`). Nothing was issued, counted or rotated, so the client retries the same request.
 * A rejected shared secret is marked as a deployment fault, which the error handler reports.
 */
function unavailable(cause: unknown) {
  return new MembershipOutage(cause, cause instanceof MembershipRejected)
}

/** Turns what the membership port throws into a contract error; anything unexpected is a 503. */
function translate(error: unknown) {
  if (error instanceof MembershipRefused) {
    return fail(
      error.reason === 'invitation_invalid'
        ? AUTH_ERRORS['signup.invitation_invalid']
        : AUTH_ERRORS['signup.organization_name_invalid']
    )
  }
  if (error instanceof MembershipFault) {
    // Not an outage: retrying cannot clear it. The flow reports it (once per attempt).
    return new MembershipFaulted(error)
  }
  return unavailable(error)
}

/** What a sign-up asks of the core service: a new Organization, or an invitation to accept. */
export type JoinRequest =
  | { kind: 'create'; name: string; email: string; memberName: string | null }
  | { kind: 'invitation'; token: string; email: string; memberName: string | null }

/**
 * Makes a new user a member of an Organization, in the one way a user can start: by creating
 * an Organization (becoming its Owner) or by accepting an invitation.
 *
 * `idempotencyKey` is fixed per sign-up attempt, so a retry after a failure or a crash returns
 * the same membership instead of creating a second Organization.
 *
 * @throws AppError `signup.invitation_invalid`, `signup.organization_name_invalid`,
 *   {@link MembershipOutage} (`membership.unavailable`) when core is down, slow or answers
 *   something unexpected, or {@link MembershipFaulted} (500) when core says the new user already
 *   belongs to an Organization.
 */
export async function join(
  deps: MembershipDeps,
  userId: UserId,
  request: JoinRequest,
  idempotencyKey: string
): Promise<Membership> {
  const controller = new AbortController()
  const { signal } = controller
  const call =
    request.kind === 'create'
      ? deps.membership.createOrganization({
          userId,
          name: request.name,
          email: request.email,
          memberName: request.memberName,
          idempotencyKey,
          signal,
        })
      : deps.membership.acceptInvitation({
          userId,
          invitationToken: request.token,
          email: request.email,
          memberName: request.memberName,
          idempotencyKey,
          signal,
        })
  try {
    return await withTimeout(call, MEMBERSHIP_TIMEOUT_MS, () => timedOut(controller))
  } catch (error) {
    throw translate(error)
  }
}

/** How many times one abandon is tried inside the request: the first, then two retries. */
export const ABANDON_ATTEMPTS = 3

/** The longest pause taken before an abandon retry, however long core asks for. */
export const ABANDON_MAX_PAUSE_MS = 1_000

/**
 * What came of asking core to abandon an Organization: `done` (core says no live Organization
 * with that id remains), `refused` (a live Organization failed core's guard; never retried) or
 * `unfinished` (core could not be asked or answered something unusable, within the bound).
 */
export type AbandonOutcome = 'done' | 'refused' | 'unfinished'

/** The pause before retry number `retry` (1 or 2): jittered, doubling, and at least core's ask. */
function abandonPauseMs(retry: number, error: unknown): number {
  const jittered = 50 * 2 ** (retry - 1) * (1 + Math.random())
  const asked = error instanceof MembershipBusy ? (error.retryAfterMs ?? 0) : 0
  return Math.min(ABANDON_MAX_PAUSE_MS, Math.max(jittered, asked))
}

/** Resolves after `ms`, or rejects when `signal` aborts first. */
function pauseFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('membership timed out'))
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
    }
    const aborted = () => {
      done()
      reject(new Error('membership timed out'))
    }
    const timer = setTimeout(() => {
      done()
      resolve()
    }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

/**
 * Asks core to abandon an Organization that a sign-up created and whose Owner's account was never
 * written. Up to {@link ABANDON_ATTEMPTS} tries with a jittered, doubling pause (at least what
 * core's `Retry-After` asked, at most {@link ABANDON_MAX_PAUSE_MS}), all inside the one
 * {@link MEMBERSHIP_TIMEOUT_MS} bound, with the same idempotency key each time. It never throws:
 * the failed sign-up's own answer must not change. A refusal is logged at warn by ids and never
 * retried; a failure that outlives the tries is logged by ids too. No address, name or message
 * of core is logged.
 */
export async function abandon(
  deps: MembershipDeps & Pick<Container, 'logger'>,
  input: { organizationId: OrganizationId; userId: UserId; idempotencyKey: string },
  options: {
    /** The whole call's bound; defaults to {@link MEMBERSHIP_TIMEOUT_MS}. */
    boundMs?: number
    /** Waits between tries; injected by tests so none sleeps. */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  } = {}
): Promise<AbandonOutcome> {
  const sleep = options.sleep ?? pauseFor
  const controller = new AbortController()
  const { signal } = controller
  const { organizationId, userId } = input
  const run = async (): Promise<AbandonOutcome> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deps.membership.abandonOrganization({ ...input, signal })
        return 'done'
      } catch (error) {
        if (error instanceof MembershipNotAbandonable) {
          deps.logger.warn('core refused to abandon an Organization', { organizationId, userId })
          return 'refused'
        }
        if (
          attempt >= ABANDON_ATTEMPTS ||
          error instanceof MembershipRejected ||
          error instanceof MembershipNotRetryable ||
          signal.aborted
        ) {
          throw error
        }
        await sleep(abandonPauseMs(attempt, error), signal)
      }
    }
  }
  try {
    return await withTimeout(run(), options.boundMs ?? MEMBERSHIP_TIMEOUT_MS, () =>
      timedOut(controller)
    )
  } catch {
    deps.logger.warn('could not abandon an Organization', { organizationId, userId })
    return 'unfinished'
  }
}

/**
 * Whether an error is the refusal to issue a token because the user's Organization was deleted.
 * Refresh uses it to end the session.
 */
export function isOrganizationDeleted(error: unknown): boolean {
  return isAppError(error) && error.code === AUTH_ERRORS['organization.deleted'].code
}

/**
 * The Organization and role of an existing user, for a token. This is where an Organization's
 * status decides what a token may be, for sign-in and refresh alike:
 *
 * - `active` and `suspended` get tokens. Core refuses writes for a suspended Organization itself,
 *   and its members must still be able to read.
 * - `deleted` gets none (`organization.deleted`, 410).
 *
 * @returns `null` when the user belongs to no Organization (the caller refuses to sign in).
 * @throws AppError `membership.unavailable` when core is down, slow or answers something
 *   unexpected (with `Retry-After`); `organization.deleted`.
 */
export async function of(deps: MembershipDeps, userId: UserId): Promise<Membership | null> {
  const controller = new AbortController()
  let found: Awaited<ReturnType<typeof deps.membership.forUser>>
  try {
    found = await withTimeout(
      deps.membership.forUser(userId, controller.signal),
      MEMBERSHIP_TIMEOUT_MS,
      () => timedOut(controller)
    )
  } catch (error) {
    throw unavailable(error)
  }
  if (found === null) {
    return null
  }
  if (found.organizationStatus === 'deleted') {
    throw fail(AUTH_ERRORS['organization.deleted'])
  }
  return { organizationId: found.organizationId, role: found.role }
}
