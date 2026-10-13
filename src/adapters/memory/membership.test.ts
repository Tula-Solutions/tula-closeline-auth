import { expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { membershipSuite } from '~/adapters/membership.suite'
import { createMemoryMembership } from '~/adapters/memory/membership'
import { createPlaceholderMembership } from '~/adapters/placeholder/membership'
import { MembershipUnavailable } from '~/ports/membership'

membershipSuite('memory', () => {
  const adapter = createMemoryMembership()
  return {
    adapter,
    invite: (token, email) =>
      adapter.invite(token, {
        email,
        organizationId: formatId('org', crypto.randomUUID()),
        role: 'rep',
      }),
    breakDown: adapter.breakDown,
  }
})

test('the placeholder never invents a membership: nobody has one and none can be made', async () => {
  const placeholder = createPlaceholderMembership()
  const userId = formatId('usr', crypto.randomUUID())

  expect(await placeholder.forUser(userId)).toBeNull()
  await expect(
    placeholder.createOrganization({ userId, name: 'A', idempotencyKey: 'k' })
  ).rejects.toBeInstanceOf(MembershipUnavailable)
  await expect(
    placeholder.acceptInvitation({
      userId,
      invitationToken: 't',
      email: 'a@b.co',
      idempotencyKey: 'k',
    })
  ).rejects.toBeInstanceOf(MembershipUnavailable)
})
