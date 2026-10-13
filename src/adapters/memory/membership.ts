import {
  ABANDON_MAX_AGE_HOURS,
  emailSchema,
  formatId,
  internalCreateOrganizationRequestSchema,
  type OrganizationStatus,
  personNameSchema,
  type Role,
  type UserId,
} from 'tula-closeline-contract'
import type { Clock } from '~/ports/clock'
import {
  type Membership,
  MembershipBusy,
  type MembershipClaims,
  type MembershipLookup,
  MembershipNotAbandonable,
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
  /** Make the abandon calls refuse as core does for a live Organization that fails its guard. */
  refuseAbandons: (refuse: boolean) => void
  /** Make the next `count` abandon calls fail as a transient outage (core busy, 503). */
  failNextAbandons: (count: number) => void
  /** Every Organization created, in order. */
  readonly organizations: { name: string; owner: UserId; organizationId: string }[]
  /** The email and name core was given for each member, in order (create and accept). */
  readonly profiles: { userId: UserId; email: string; name: string | null }[]
  /** Every abandon call received, in order, with the key it carried. */
  readonly abandons: { organizationId: string; userId: UserId; idempotencyKey: string }[]
  /** How many calls were made, by operation. */
  readonly calls: {
    create: number
    accept: number
    lookup: number
    abandon: number
    aborted: number
  }
}

/** Builds the memory membership. Its answers are what the real service gives, minus the network. */
export function createMemoryMembership(clock: Clock = { now: () => new Date() }): MemoryMembership {
  const members = new Map<string, Membership>()
  const byKey = new Map<string, Membership>()
  const invitations = new Map<string, { email: string; organizationId: string; role: Role }>()
  const organizations: MemoryMembership['organizations'] = []
  const statuses = new Map<string, OrganizationStatus>()
  const createdAt = new Map<string, Date>()
  const profiles: MemoryMembership['profiles'] = []
  const abandons: MemoryMembership['abandons'] = []
  const calls = { create: 0, accept: 0, lookup: 0, abandon: 0, aborted: 0 }
  let broken = false
  let refusing = false
  let failing = 0
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
    profiles,
    abandons,
    calls,
    refuseAbandons: (refuse) => {
      refusing = refuse
    },
    failNextAbandons: (count) => {
      failing = count
    },
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
    async createOrganization({ userId, name, email, memberName, idempotencyKey, signal }) {
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
      // Core answers 400 to a request the contract refuses; the adapter sees that as unavailable.
      if (
        !internalCreateOrganizationRequestSchema.safeParse({
          userId,
          organizationName: name,
          email,
          name: memberName,
        }).success
      ) {
        throw new MembershipUnavailable('core refused the request')
      }
      profiles.push({ userId, email, name: memberName })
      const membership: Membership = { organizationId: newOrganizationId(), role: 'owner' }
      createdAt.set(membership.organizationId, clock.now())
      organizations.push({ name, owner: userId, organizationId: membership.organizationId })
      members.set(userId, membership)
      byKey.set(idempotencyKey, membership)
      return membership
    },
    async acceptInvitation({ userId, invitationToken, email, memberName, idempotencyKey, signal }) {
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
      if (
        !emailSchema.safeParse(email).success ||
        (memberName !== null && !personNameSchema.safeParse(memberName).success)
      ) {
        throw new MembershipUnavailable('core refused the request')
      }
      invitations.delete(invitationToken)
      profiles.push({ userId, email, name: memberName })
      const membership: Membership = {
        organizationId: invitation.organizationId as Membership['organizationId'],
        role: invitation.role,
      }
      members.set(userId, membership)
      byKey.set(idempotencyKey, membership)
      return membership
    },
    async abandonOrganization({ organizationId, userId, idempotencyKey, signal }) {
      calls.abandon += 1
      abandons.push({ organizationId, userId, idempotencyKey })
      guard()
      await proceed(signal)
      if (failing > 0) {
        failing -= 1
        throw new MembershipBusy(undefined, 'core answered HTTP 503')
      }
      const here = [...members.entries()].filter(([, m]) => m.organizationId === organizationId)
      const live = here.length > 0 && statuses.get(organizationId) !== 'deleted'
      if (!live) {
        return
      }
      const [only] = here
      // Like core: one member and it is this user, not suspended, and under 24 hours old.
      const born = createdAt.get(organizationId)
      const old =
        born !== undefined &&
        clock.now().getTime() - born.getTime() >= ABANDON_MAX_AGE_HOURS * 3_600_000
      if (
        refusing ||
        here.length !== 1 ||
        only?.[0] !== userId ||
        statuses.get(organizationId) === 'suspended' ||
        old
      ) {
        throw new MembershipNotAbandonable()
      }
      // Core frees the user id at once and forgets the sign-up's key, so a retry starts afresh.
      members.delete(userId)
      statuses.set(organizationId, 'deleted')
      for (const [key, value] of byKey) {
        if (value.organizationId === organizationId) {
          byKey.delete(key)
        }
      }
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
