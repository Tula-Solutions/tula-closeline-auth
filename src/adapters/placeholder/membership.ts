import { type MembershipClaims, MembershipUnavailable } from '~/ports/membership'

/**
 * What `local` runs on when no core service is configured (`CORE_BASE_URL` and
 * `CORE_INTERNAL_TOKEN` unset), so the service still boots alone: nobody can sign up (both ways
 * need core) and `forUser` answers none, so no token is issued. It never invents a membership.
 * The container never selects it outside `local`.
 */
export function createPlaceholderMembership(): MembershipClaims {
  const unavailable = async (input?: { signal?: AbortSignal }): Promise<never> => {
    input?.signal?.throwIfAborted()
    throw new MembershipUnavailable('the core service is not connected yet (placeholder adapter)')
  }
  return {
    createOrganization: unavailable,
    acceptInvitation: unavailable,
    abandonOrganization: unavailable,
    verifyApiKey: async (_secret, signal) => unavailable({ signal }),
    forUser: async (_userId, signal) => {
      signal?.throwIfAborted()
      return null
    },
  }
}
