import type { OrganizationId, Role, UserId } from 'tula-closeline-contract'

/** The Organization a user belongs to and their role in it: what a token's `org` and `role` say. */
export type Membership = { organizationId: OrganizationId; role: Role }

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
 * Organization membership, which lives in the core service (ADR 0005). Auth never stores it: it
 * asks, once per token, and stamps the answer into `org` and `role`. Every call has a timeout and
 * is idempotent on its key, so a retried sign-up cannot create a second Organization.
 */
export interface MembershipClaims {
  /**
   * Create an Organization for a user who is signing up; the user becomes its Owner.
   *
   * @param input.idempotencyKey - Fixed per sign-up attempt: the same key returns the same result.
   * @throws MembershipRefused `organization_name_invalid`; MembershipUnavailable on any failure.
   */
  createOrganization(input: {
    userId: UserId
    name: string
    idempotencyKey: string
  }): Promise<Membership>

  /**
   * Add a user who is signing up to the Organization that invited them.
   *
   * @param input.email - The verified address the invitation must have been sent to.
   * @throws MembershipRefused `invitation_invalid`; MembershipUnavailable on any failure.
   */
  acceptInvitation(input: {
    userId: UserId
    invitationToken: string
    email: string
    idempotencyKey: string
  }): Promise<Membership>

  /**
   * The Organization and role to stamp for an existing user, or `null` if they have none (a
   * fault: a sign-up never leaves an account without one).
   *
   * @throws MembershipUnavailable on any failure.
   */
  forUser(userId: UserId): Promise<Membership | null>
}
