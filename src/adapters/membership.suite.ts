import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { type MembershipClaims, MembershipRefused, MembershipUnavailable } from '~/ports/membership'

/** What the membership suite needs: the adapter and a way to arrange an invitation for it. */
export type MembershipHarness = {
  adapter: MembershipClaims
  invite: (token: string, email: string) => void
  breakDown: (broken: boolean) => void
}

/** The behaviour every MembershipClaims adapter that can create memberships has. */
export function membershipSuite(name: string, make: () => MembershipHarness): void {
  const user = () => formatId('usr', crypto.randomUUID())
  describe(`${name} membership`, () => {
    test('creating an Organization makes the user its owner, and asking again with the same key returns the same one', async () => {
      const { adapter } = make()
      const userId = user()
      const key = crypto.randomUUID()

      const first = await adapter.createOrganization({
        userId,
        name: 'Northline',
        idempotencyKey: key,
      })
      const second = await adapter.createOrganization({
        userId,
        name: 'Northline',
        idempotencyKey: key,
      })

      expect(first.role).toBe('owner')
      expect(second).toEqual(first)
      expect(await adapter.forUser(userId)).toEqual(first)
    })

    test('an unknown user has no membership', async () => {
      expect(await make().adapter.forUser(user())).toBeNull()
    })

    test('an invitation is accepted once, for the address it was sent to', async () => {
      const harness = make()
      harness.invite('inv-1', 'rep@example.com')
      const userId = user()

      const wrongAddress = harness.adapter.acceptInvitation({
        userId,
        invitationToken: 'inv-1',
        email: 'other@example.com',
        idempotencyKey: crypto.randomUUID(),
      })
      await expect(wrongAddress).rejects.toBeInstanceOf(MembershipRefused)
      const joined = await harness.adapter.acceptInvitation({
        userId,
        invitationToken: 'inv-1',
        email: 'rep@example.com',
        idempotencyKey: crypto.randomUUID(),
      })

      expect(await harness.adapter.forUser(userId)).toEqual(joined)
      const again = harness.adapter.acceptInvitation({
        userId: user(),
        invitationToken: 'inv-1',
        email: 'rep@example.com',
        idempotencyKey: crypto.randomUUID(),
      })
      await expect(again).rejects.toMatchObject({ reason: 'invitation_invalid' })
    })

    test('an unknown invitation is refused', async () => {
      const refused = make().adapter.acceptInvitation({
        userId: user(),
        invitationToken: 'nope',
        email: 'a@example.com',
        idempotencyKey: crypto.randomUUID(),
      })

      await expect(refused).rejects.toMatchObject({ reason: 'invitation_invalid' })
    })

    test('a blank Organization name is refused', async () => {
      const refused = make().adapter.createOrganization({
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
          userId: user(),
          name: 'A',
          idempotencyKey: crypto.randomUUID(),
        })
      ).rejects.toBeInstanceOf(MembershipUnavailable)
    })
  })
}
