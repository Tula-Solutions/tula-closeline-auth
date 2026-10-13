import { describe, expect, test } from 'bun:test'
import { formatId, type UserId } from 'tula-closeline-contract'
import { createMemoryMembership } from '~/adapters/memory/membership'
import { MembershipUnavailable } from '~/ports/membership'
import * as Membership from './service'

const userId = formatId('usr', crypto.randomUUID()) as UserId

describe('joining an Organization', () => {
  test('creates one for a new user, once per idempotency key', async () => {
    const membership = createMemoryMembership()

    const first = await Membership.join(
      { membership },
      userId,
      { kind: 'create', name: 'Northline', email: 'maya@northline.app', memberName: null },
      'signup:1'
    )
    const again = await Membership.join(
      { membership },
      userId,
      { kind: 'create', name: 'Northline', email: 'maya@northline.app', memberName: null },
      'signup:1'
    )

    expect(first.role).toBe('owner')
    expect(again).toEqual(first)
    expect(membership.organizations).toHaveLength(1)
  })

  test('turns a refusal into the contract error for it', async () => {
    const membership = createMemoryMembership()

    await expect(
      Membership.join(
        { membership },
        userId,
        { kind: 'create', name: '  ', email: 'maya@northline.app', memberName: null },
        'k1'
      )
    ).rejects.toMatchObject({ code: 'signup.organization_name_invalid', status: 422 })
    await expect(
      Membership.join(
        { membership },
        userId,
        { kind: 'invitation', token: 'nope', email: 'a@b.app', memberName: null },
        'k2'
      )
    ).rejects.toMatchObject({ code: 'signup.invitation_invalid', status: 422 })
  })

  test('a service that is down or answers something unexpected is a 503', async () => {
    const membership = createMemoryMembership()
    membership.breakDown(true)

    await expect(
      Membership.join(
        { membership },
        userId,
        { kind: 'create', name: 'Northline', email: 'maya@northline.app', memberName: null },
        'k'
      )
    ).rejects.toMatchObject({ code: 'membership.unavailable', status: 503 })
    await expect(Membership.of({ membership }, userId)).rejects.toMatchObject({
      code: 'membership.unavailable',
    })
    const odd = {
      ...createMemoryMembership(),
      forUser: async () => {
        throw new TypeError('socket hang up')
      },
    }
    await expect(Membership.of({ membership: odd }, userId)).rejects.toMatchObject({ status: 503 })
    expect(new MembershipUnavailable().message).toContain('unavailable')
  })

  test('stops waiting for a service that never answers', async () => {
    const never = new Promise<never>(() => {})
    const membership = { ...createMemoryMembership(), forUser: () => never }
    const real = globalThis.setTimeout
    // Shrink the deadline for this test only; the production value is 5 seconds.
    globalThis.setTimeout = ((fn: () => void) => real(fn, 1)) as unknown as typeof setTimeout
    try {
      await expect(Membership.of({ membership }, userId)).rejects.toMatchObject({
        code: 'membership.unavailable',
      })
    } finally {
      globalThis.setTimeout = real
    }
  })
})

describe('a call that is given up on', () => {
  /** Shrinks the deadline for one test only; the production value is 5 seconds. */
  async function withShortDeadline<T>(work: () => Promise<T>): Promise<T> {
    const real = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void) => real(fn, 1)) as unknown as typeof setTimeout
    try {
      return await work()
    } finally {
      globalThis.setTimeout = real
    }
  }

  test('a core that never answers is told to stop: the signal aborts when the bound is hit', async () => {
    let seen: AbortSignal | undefined
    const membership = {
      ...createMemoryMembership(),
      createOrganization: ({ signal }: { signal?: AbortSignal }) => {
        seen = signal
        return new Promise<never>(() => {})
      },
    }

    await withShortDeadline(async () => {
      await expect(
        Membership.join(
          { membership },
          userId,
          { kind: 'create', name: 'Northline', email: 'maya@northline.app', memberName: null },
          'k'
        )
      ).rejects.toMatchObject({ code: 'membership.unavailable', status: 503 })
    })

    expect(seen?.aborted).toBe(true)
  })

  test('the same for an invitation and for a lookup', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const hang = (input?: { signal?: AbortSignal } | AbortSignal) => {
      signals.push(input instanceof AbortSignal ? input : input?.signal)
      return new Promise<never>(() => {})
    }
    const membership = {
      ...createMemoryMembership(),
      acceptInvitation: hang,
      forUser: (_id: UserId, signal?: AbortSignal) => hang(signal),
    }

    await withShortDeadline(async () => {
      await expect(
        Membership.join(
          { membership },
          userId,
          { kind: 'invitation', token: 't', email: 'a@b.app', memberName: null },
          'k'
        )
      ).rejects.toMatchObject({ code: 'membership.unavailable' })
      await expect(Membership.of({ membership }, userId)).rejects.toMatchObject({
        code: 'membership.unavailable',
      })
    })

    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true)
  })

  test('a call that finishes in time is not aborted', async () => {
    const membership = createMemoryMembership()
    let seen: AbortSignal | undefined
    const createOrganization = membership.createOrganization.bind(membership)
    membership.createOrganization = (input) => {
      seen = input.signal
      return createOrganization(input)
    }

    await Membership.join(
      { membership },
      userId,
      { kind: 'create', name: 'Northline', email: 'maya@northline.app', memberName: null },
      'k'
    )

    expect(seen?.aborted).toBe(false)
  })
})

describe('what a token may be issued for', () => {
  const setup = async () => {
    const membership = createMemoryMembership()
    const { organizationId } = await membership.createOrganization({
      email: 'maya@northline.app',
      memberName: null,
      userId,
      name: 'Northline',
      idempotencyKey: 'signup:status-test-key',
    })
    return { membership, organizationId }
  }

  test('the answer carries the Organization and role and nothing else, whatever the status', async () => {
    const { membership, organizationId } = await setup()

    for (const status of ['active', 'suspended'] as const) {
      membership.setOrganizationStatus(organizationId, status)
      expect(await Membership.of({ membership }, userId)).toEqual({ organizationId, role: 'owner' })
    }
  })

  test('a deleted Organization is refused, and the refusal can be told from an outage', async () => {
    const { membership, organizationId } = await setup()
    membership.setOrganizationStatus(organizationId, 'deleted')

    const refused = await Membership.of({ membership }, userId).catch((e: unknown) => e)
    membership.breakDown(true)
    const outage = await Membership.of({ membership }, userId).catch((e: unknown) => e)

    expect(refused).toMatchObject({ code: 'organization.deleted', status: 410 })
    expect(Membership.isOrganizationDeleted(refused)).toBe(true)
    expect(Membership.isOrganizationDeleted(outage)).toBe(false)
    expect(Membership.isOrganizationDeleted(new Error('organization.deleted'))).toBe(false)
  })

  test('an outage tells the client when to try again', async () => {
    const { membership } = await setup()
    membership.breakDown(true)

    await expect(Membership.of({ membership }, userId)).rejects.toMatchObject({
      details: { retryAfter: Membership.MEMBERSHIP_RETRY_AFTER_SECONDS },
    })
    await expect(
      Membership.join(
        { membership },
        userId,
        { kind: 'create', name: 'A', email: 'maya@northline.app', memberName: null },
        'signup:another-key-1'
      )
    ).rejects.toMatchObject({ details: { retryAfter: Membership.MEMBERSHIP_RETRY_AFTER_SECONDS } })
  })
})
