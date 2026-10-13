import type { UserId } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { AUTH_ERRORS, fail } from '~/errors'
import { withTimeout } from '~/lib/timeout'
import { type Membership, MembershipRefused } from '~/ports/membership'

/** The longest a call to the core service may take before the caller gives up on it. */
export const MEMBERSHIP_TIMEOUT_MS = 5_000

/** What a membership call needs from the container. */
export type MembershipDeps = Pick<Container, 'membership'>

/** Cancels the call that ran out of time (so the adapter can stop it) and names the failure. */
function timedOut(controller: AbortController): Error {
  controller.abort()
  return new Error('membership timed out')
}

/** The error a membership call that did not answer in time or failed turns into (503). */
function unavailable(cause: unknown) {
  return fail(AUTH_ERRORS['membership.unavailable'], undefined, cause)
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
  return unavailable(error)
}

/** What a sign-up asks of the core service: a new Organization, or an invitation to accept. */
export type JoinRequest =
  | { kind: 'create'; name: string }
  | { kind: 'invitation'; token: string; email: string }

/**
 * Makes a new user a member of an Organization, in the one way a user can start: by creating
 * an Organization (becoming its Owner) or by accepting an invitation.
 *
 * `idempotencyKey` is fixed per sign-up attempt, so a retry after a failure or a crash returns
 * the same membership instead of creating a second Organization.
 *
 * @throws AppError `signup.invitation_invalid`, `signup.organization_name_invalid`, or
 *   `membership.unavailable` when core is down, slow or answers something unexpected.
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
      ? deps.membership.createOrganization({ userId, name: request.name, idempotencyKey, signal })
      : deps.membership.acceptInvitation({
          userId,
          invitationToken: request.token,
          email: request.email,
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
 * The Organization and role of an existing user, for a token.
 *
 * @returns `null` when the user belongs to no Organization (the caller refuses to sign in).
 * @throws AppError `membership.unavailable` when core is down or slow.
 */
export async function of(deps: MembershipDeps, userId: UserId): Promise<Membership | null> {
  const controller = new AbortController()
  try {
    return await withTimeout(
      deps.membership.forUser(userId, controller.signal),
      MEMBERSHIP_TIMEOUT_MS,
      () => timedOut(controller)
    )
  } catch (error) {
    throw unavailable(error)
  }
}
