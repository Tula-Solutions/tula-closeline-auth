import { AUTH_ERRORS, type UserId } from 'tula-closeline-contract'
import { isAppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { fail, MembershipFaulted, MembershipOutage } from '~/errors'
import { withTimeout } from '~/lib/timeout'
import {
  type Membership,
  MembershipFault,
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
