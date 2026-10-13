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

test('the memory adapter fails a call whose signal is already aborted, or aborts while it is held', async () => {
  const membership = createMemoryMembership()
  const userId = formatId('usr', crypto.randomUUID())
  const aborted = AbortSignal.abort()

  await expect(
    membership.createOrganization({ userId, name: 'A', idempotencyKey: 'k1', signal: aborted })
  ).rejects.toBeInstanceOf(MembershipUnavailable)
  await expect(membership.forUser(userId, aborted)).rejects.toBeInstanceOf(MembershipUnavailable)
  const release = membership.hold()
  const controller = new AbortController()
  const held = membership.createOrganization({
    userId,
    name: 'A',
    idempotencyKey: 'k2',
    signal: controller.signal,
  })
  controller.abort()

  await expect(held).rejects.toBeInstanceOf(MembershipUnavailable)
  release()
  expect(membership.organizations).toHaveLength(0)
  expect(membership.calls.aborted).toBe(3)
})

test('the placeholder honours an aborted signal too', async () => {
  const placeholder = createPlaceholderMembership()
  const userId = formatId('usr', crypto.randomUUID())

  await expect(placeholder.forUser(userId, AbortSignal.abort())).rejects.toBeDefined()
  await expect(
    placeholder.createOrganization({
      userId,
      name: 'A',
      idempotencyKey: 'k',
      signal: AbortSignal.abort(),
    })
  ).rejects.toBeDefined()
})
