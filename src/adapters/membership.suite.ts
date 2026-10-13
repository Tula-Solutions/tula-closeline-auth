import { describe, expect, test } from 'bun:test'
import { formatId, type OrganizationStatus } from 'tula-closeline-contract'
import { type MembershipClaims, MembershipRefused, MembershipUnavailable } from '~/ports/membership'

/** What the membership suite needs: the adapter and a way to arrange an invitation for it. */
export type MembershipHarness = {
  adapter: MembershipClaims
  invite: (token: string, email: string) => void
  breakDown: (broken: boolean) => void
  /** Sets an Organization's status, as an operator would in core. */
  setStatus: (organizationId: string, status: OrganizationStatus) => void
}

/** A well-formed Invitation token (22 or more URL-safe characters), as the contract requires. */
const token = (label: string) => `${label}-${'x'.repeat(24)}`

/** The behaviour every MembershipClaims adapter that can create memberships has. */
export function membershipSuite(name: string, make: () => MembershipHarness): void {
  const user = () => formatId('usr', crypto.randomUUID())
  describe(`${name} membership`, () => {
    test('creating an Organization makes the user its owner, and asking again with the same key returns the same one', async () => {
      const { adapter } = make()
      const userId = user()
      const key = crypto.randomUUID()

      const first = await adapter.createOrganization({
        email: 'maya@northline.app',
        memberName: null,
        userId,
        name: 'Northline',
        idempotencyKey: key,
      })
      const second = await adapter.createOrganization({
        email: 'maya@northline.app',
        memberName: null,
        userId,
        name: 'Northline',
        idempotencyKey: key,
      })

      expect(first.role).toBe('owner')
      expect(second).toEqual(first)
      expect(await adapter.forUser(userId)).toEqual({ ...first, organizationStatus: 'active' })
    })

    test('an unknown user has no membership', async () => {
      expect(await make().adapter.forUser(user())).toBeNull()
    })

    test('an invitation is accepted once, for the address it was sent to', async () => {
      const harness = make()
      harness.invite(token('inv-1'), 'rep@example.com')
      const userId = user()

      const wrongAddress = harness.adapter.acceptInvitation({
        memberName: null,
        userId,
        invitationToken: token('inv-1'),
        email: 'other@example.com',
        idempotencyKey: crypto.randomUUID(),
      })
      await expect(wrongAddress).rejects.toBeInstanceOf(MembershipRefused)
      const joined = await harness.adapter.acceptInvitation({
        memberName: null,
        userId,
        invitationToken: token('inv-1'),
        email: 'rep@example.com',
        idempotencyKey: crypto.randomUUID(),
      })

      expect(await harness.adapter.forUser(userId)).toMatchObject(joined)
      const again = harness.adapter.acceptInvitation({
        memberName: null,
        userId: user(),
        invitationToken: token('inv-1'),
        email: 'rep@example.com',
        idempotencyKey: crypto.randomUUID(),
      })
      await expect(again).rejects.toMatchObject({ reason: 'invitation_invalid' })
    })

    test('an unknown invitation is refused, whatever the token looks like', async () => {
      const { adapter } = make()

      for (const invitationToken of [token('unknown'), 'nope']) {
        const refused = adapter.acceptInvitation({
          memberName: null,
          userId: user(),
          invitationToken,
          email: 'a@example.com',
          idempotencyKey: crypto.randomUUID(),
        })

        await expect(refused).rejects.toMatchObject({ reason: 'invitation_invalid' })
      }
    })

    test('the lookup reports the status of the Organization', async () => {
      const { adapter, setStatus } = make()
      const userId = user()
      const { organizationId } = await adapter.createOrganization({
        email: 'maya@northline.app',
        memberName: null,
        userId,
        name: 'Northline',
        idempotencyKey: crypto.randomUUID(),
      })

      for (const status of ['suspended', 'deleted', 'active'] as const) {
        setStatus(organizationId, status)
        expect(await adapter.forUser(userId)).toMatchObject({
          organizationId,
          organizationStatus: status,
        })
      }
    })

    test('a blank Organization name is refused', async () => {
      const refused = make().adapter.createOrganization({
        email: 'maya@northline.app',
        memberName: null,
        userId: user(),
        name: '   ',
        idempotencyKey: crypto.randomUUID(),
      })

      await expect(refused).rejects.toMatchObject({ reason: 'organization_name_invalid' })
    })

    test('when the service is down every operation says so', async () => {
      const harness = make()
      harness.breakDown(true)

      await expect(harness.adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)
      await expect(
        harness.adapter.createOrganization({
          email: 'maya@northline.app',
          memberName: null,
          userId: user(),
          name: 'A',
          idempotencyKey: crypto.randomUUID(),
        })
      ).rejects.toBeInstanceOf(MembershipUnavailable)
    })
  })
}
