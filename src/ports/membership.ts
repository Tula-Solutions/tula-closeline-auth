import type { OrganizationId, OrganizationStatus, Role, UserId } from 'tula-closeline-contract'

/** The Organization a user belongs to and their role in it: what a token's `org` and `role` say. */
export type Membership = { organizationId: OrganizationId; role: Role }

/**
 * What the lookup for an existing user returns: their {@link Membership} and the status of the
 * Organization (core's answer; `modules/membership` decides what each status means for a token).
 */
export type MembershipLookup = Membership & { organizationStatus: OrganizationStatus }

/** Why the core service refused a membership step; the caller turns it into a contract error. */
export type MembershipRefusal = 'invitation_invalid' | 'organization_name_invalid'

/** Thrown when the membership step was refused for a reason the user can fix. */
export class MembershipRefused extends Error {
  readonly reason: MembershipRefusal
  constructor(reason: MembershipRefusal) {
    super(`membership refused: ${reason}`)
    this.name = 'MembershipRefused'
    this.reason = reason
  }
}

/** Thrown when the membership step could not be completed (core unreachable, timed out, failed). */
export class MembershipUnavailable extends Error {
  constructor(message = 'membership is unavailable') {
    super(message)
    this.name = 'MembershipUnavailable'
  }
}

/**
 * Thrown when core's answer shows a fault that retrying cannot clear and the person cannot fix:
 * it says the user already belongs to an Organization, though auth made that user id for this
 * attempt alone. Unlike {@link MembershipUnavailable} it is not a temporary outage, so the caller
 * does not tell the client to try again.
 */
export class MembershipFault extends Error {
  constructor(message = 'membership answered with a fault') {
    super(message)
    this.name = 'MembershipFault'
  }
}

/**
 * Thrown (as a kind of {@link MembershipUnavailable}) when core refused the shared secret: a
 * wrong or missing credential is a deployment fault that stays until someone fixes it, so unlike a
 * plain outage it reaches the error tracker, a limited number of times.
 */
export class MembershipRejected extends MembershipUnavailable {
  constructor(message = 'core refused the service credentials') {
    super(message)
    this.name = 'MembershipRejected'
  }
}

/**
 * Organization membership, which lives in the core service (ADR 0005). Auth never stores it: it
 * asks, once per token, and stamps the answer into `org` and `role`. Every call has a timeout and
 * is idempotent on its key, so a retried sign-up cannot create a second Organization.
 */
export interface MembershipClaims {
  /**
   * Create an Organization for a user who is signing up; the user becomes its Owner.
   *
   * @param input.idempotencyKey - Fixed per sign-up attempt: the same key returns the same result.
   * @param input.signal - Aborts when the caller has stopped waiting (the 5 second bound), so an
   *   adapter cancels the request instead of leaving it running; an aborted call is
   *   MembershipUnavailable.
   * @throws MembershipRefused `organization_name_invalid`; MembershipFault when core says the user
   *   is already a member; MembershipUnavailable on any other failure.
   */
  createOrganization(input: {
    userId: UserId
    name: string
    idempotencyKey: string
    signal?: AbortSignal
  }): Promise<Membership>

  /**
   * Add a user who is signing up to the Organization that invited them.
   *
   * @param input.email - The verified address the invitation must have been sent to.
   * @param input.signal - As for {@link MembershipClaims.createOrganization}.
   * @throws MembershipRefused `invitation_invalid`; MembershipFault as for
   *   {@link MembershipClaims.createOrganization}; MembershipUnavailable on any other failure.
   */
  acceptInvitation(input: {
    userId: UserId
    invitationToken: string
    email: string
    idempotencyKey: string
    signal?: AbortSignal
  }): Promise<Membership>

  /**
   * The Organization, role and Organization status for an existing user, or `null` if they have
   * none (a fault: a sign-up never leaves an account without one). An adapter retries this read
   * once on a transient failure, inside the bound the caller enforces.
   *
   * @param signal - As for {@link MembershipClaims.createOrganization}.
   * @throws MembershipUnavailable on any failure.
   */
  forUser(userId: UserId, signal?: AbortSignal): Promise<MembershipLookup | null>
}
