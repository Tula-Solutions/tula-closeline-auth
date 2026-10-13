import { type MembershipClaims, MembershipUnavailable } from '~/ports/membership'

/**
 * PLACEHOLDER for the real membership adapter, which calls the core service (ticket 1.9, the
 * token hook). Until it exists the runtime has no source of an Organization: nobody can sign up
 * (the two ways to sign up both need core) and `forUser` answers none, so no token is issued.
 * It never invents a membership.
 */
export function createPlaceholderMembership(): MembershipClaims {
  const unavailable = async (input?: { signal?: AbortSignal }): Promise<never> => {
    input?.signal?.throwIfAborted()
    throw new MembershipUnavailable('the core service is not connected yet (placeholder adapter)')
  }
  return {
    createOrganization: unavailable,
    acceptInvitation: unavailable,
    forUser: async (_userId, signal) => {
      signal?.throwIfAborted()
      return null
    },
  }
}
