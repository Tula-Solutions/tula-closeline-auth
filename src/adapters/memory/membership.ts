import { formatId, type OrganizationStatus, type Role, type UserId } from 'tula-closeline-contract'
import {
  type Membership,
  type MembershipClaims,
  type MembershipLookup,
  MembershipRefused,
  MembershipUnavailable,
} from '~/ports/membership'

/** The in-memory membership service for tests, with controls to arrange and break it. */
export type MemoryMembership = MembershipClaims & {
  /** An invitation that `acceptInvitation` will honour for this address. */
  invite: (token: string, invitation: { email: string; organizationId: string; role: Role }) => void
  /** Make every following call fail as unavailable (`true`) or work again (`false`). */
  breakDown: (broken: boolean) => void
  /** Set the status of an Organization: the lookups of its members report it (default `active`). */
  setOrganizationStatus: (organizationId: string, status: OrganizationStatus) => void
  /** Make the next `forUser` for this user answer none, as if the account had no membership. */
  forget: (userId: UserId) => void
  /**
   * Make create and accept calls wait, as a slow core would, until the returned function is
   * called or the call's signal aborts. Lookups (`forUser`) are not held.
   */
  hold: () => () => void
  /** Every Organization created, in order. */
  readonly organizations: { name: string; owner: UserId; organizationId: string }[]
  /** How many calls were made, by operation. */
  readonly calls: { create: number; accept: number; lookup: number; aborted: number }
}

/** Builds the memory membership. Its answers are what the real service gives, minus the network. */
export function createMemoryMembership(): MemoryMembership {
  const members = new Map<string, Membership>()
  const byKey = new Map<string, Membership>()
  const invitations = new Map<string, { email: string; organizationId: string; role: Role }>()
  const organizations: MemoryMembership['organizations'] = []
  const statuses = new Map<string, OrganizationStatus>()
  const calls = { create: 0, accept: 0, lookup: 0, aborted: 0 }
  let broken = false
  const guard = () => {
    if (broken) {
      throw new MembershipUnavailable()
    }
  }
  let gate: Promise<void> | undefined
  /** Fails an aborted call like a dropped connection, and waits out a hold unless aborted. */
  const proceed = async (signal: AbortSignal | undefined) => {
    const aborted = () => {
      calls.aborted += 1
      return new MembershipUnavailable('the call was aborted')
    }
    if (signal?.aborted) {
      throw aborted()
    }
    if (gate && signal) {
      await Promise.race([
        gate,
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(aborted()), { once: true })
        ),
      ])
    } else if (gate) {
      await gate
    }
  }
  const newOrganizationId = () => formatId('org', crypto.randomUUID())

  return {
    organizations,
    calls,
    hold: () => {
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        gate = undefined
        release()
      }
    },
    invite: (token, invitation) => void invitations.set(token, invitation),
    breakDown: (value) => {
      broken = value
    },
    setOrganizationStatus: (organizationId, status) => void statuses.set(organizationId, status),
    forget: (userId) => void members.delete(userId),
    async createOrganization({ userId, name, idempotencyKey, signal }) {
      calls.create += 1
      guard()
      await proceed(signal)
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
    async acceptInvitation({ userId, invitationToken, email, idempotencyKey, signal }) {
      calls.accept += 1
      guard()
      await proceed(signal)
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
    async forUser(userId, signal) {
      calls.lookup += 1
      guard()
      if (signal?.aborted) {
        calls.aborted += 1
        throw new MembershipUnavailable('the call was aborted')
      }
      const membership = members.get(userId)
      if (!membership) {
        return null
      }
      const lookup: MembershipLookup = {
        ...membership,
        organizationStatus: statuses.get(membership.organizationId) ?? 'active',
      }
      return lookup
    },
  }
}
