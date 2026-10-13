import { formatId, type Role, type UserId } from 'tula-closeline-contract'
import {
  type Membership,
  type MembershipClaims,
  MembershipRefused,
  MembershipUnavailable,
} from '~/ports/membership'

/** The in-memory membership service for tests, with controls to arrange and break it. */
export type MemoryMembership = MembershipClaims & {
  /** An invitation that `acceptInvitation` will honour for this address. */
  invite: (token: string, invitation: { email: string; organizationId: string; role: Role }) => void
  /** Make every following call fail as unavailable (`true`) or work again (`false`). */
  breakDown: (broken: boolean) => void
  /** Make the next `forUser` for this user answer none, as if the account had no membership. */
  forget: (userId: UserId) => void
  /** Every Organization created, in order. */
  readonly organizations: { name: string; owner: UserId; organizationId: string }[]
  /** How many calls were made, by operation. */
  readonly calls: { create: number; accept: number; lookup: number }
}

/** Builds the memory membership. Its answers are what the real service gives, minus the network. */
export function createMemoryMembership(): MemoryMembership {
  const members = new Map<string, Membership>()
  const byKey = new Map<string, Membership>()
  const invitations = new Map<string, { email: string; organizationId: string; role: Role }>()
  const organizations: MemoryMembership['organizations'] = []
  const calls = { create: 0, accept: 0, lookup: 0 }
  let broken = false
  const guard = () => {
    if (broken) {
      throw new MembershipUnavailable()
    }
  }
  const newOrganizationId = () => formatId('org', crypto.randomUUID())

  return {
    organizations,
    calls,
    invite: (token, invitation) => void invitations.set(token, invitation),
    breakDown: (value) => {
      broken = value
    },
    forget: (userId) => void members.delete(userId),
    async createOrganization({ userId, name, idempotencyKey }) {
      calls.create += 1
      guard()
      const earlier = byKey.get(idempotencyKey)
      if (earlier) {
        return earlier
      }
      if (name.trim() === '') {
        throw new MembershipRefused('organization_name_invalid')
      }
      const membership: Membership = { organizationId: newOrganizationId(), role: 'owner' }
      organizations.push({ name, owner: userId, organizationId: membership.organizationId })
      members.set(userId, membership)
      byKey.set(idempotencyKey, membership)
      return membership
    },
    async acceptInvitation({ userId, invitationToken, email, idempotencyKey }) {
      calls.accept += 1
      guard()
      const earlier = byKey.get(idempotencyKey)
      if (earlier) {
        return earlier
      }
      const invitation = invitations.get(invitationToken)
      if (!invitation || invitation.email !== email) {
        throw new MembershipRefused('invitation_invalid')
      }
      invitations.delete(invitationToken)
      const membership: Membership = {
        organizationId: invitation.organizationId as Membership['organizationId'],
        role: invitation.role,
      }
      members.set(userId, membership)
      byKey.set(idempotencyKey, membership)
      return membership
    },
    async forUser(userId) {
      calls.lookup += 1
      guard()
      return members.get(userId) ?? null
    },
  }
}
