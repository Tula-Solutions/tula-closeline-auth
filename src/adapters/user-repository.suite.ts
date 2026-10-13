import { beforeEach, describe, expect, test } from 'bun:test'
import type { NewUser, UserRepository } from '~/ports/user-repository'

/** A tenant a repository under test runs in. */
export interface UserSuiteTenant {
  projectId: string
  environmentId: string
}

/** What a repository under test provides. */
export interface UserSuiteContext {
  users: UserRepository
  a: UserSuiteTenant
  b: UserSuiteTenant
}

const T0 = new Date('2026-01-01T00:00:00Z')

function newUser(tenant: UserSuiteTenant, email: string, hash = '$argon2id$one'): NewUser {
  return {
    id: Bun.randomUUIDv7(),
    identityId: Bun.randomUUIDv7(),
    credentialId: Bun.randomUUIDv7(),
    ...tenant,
    email,
    emailNormalized: email.toLowerCase(),
    emailVerifiedAt: T0,
    firstName: null,
    lastName: null,
    createdAt: T0,
    passwordHash: hash,
  }
}

/** Behaviour every `UserRepository` has, memory included (one suite, each adapter). */
export function userRepositorySuite(name: string, setup: () => Promise<UserSuiteContext>): void {
  describe(`${name} (UserRepository)`, () => {
    let ctx: UserSuiteContext
    beforeEach(async () => {
      ctx = await setup()
    })

    test('creates a user and finds them by id and by normalized email', async () => {
      const user = newUser(ctx.a, 'Maya@Northline.app')
      expect(await ctx.users.create(user)).toBe(true)

      const byId = await ctx.users.findById(ctx.a.environmentId, user.id)
      const byEmail = await ctx.users.findByEmail(ctx.a.environmentId, 'maya@northline.app')
      expect(byId?.email).toBe('Maya@Northline.app')
      expect(byId?.bannedAt).toBeNull()
      expect(byEmail?.id).toBe(user.id)
    })

    test('returns the password hash and its age with the user for sign-in', async () => {
      const user = newUser(ctx.a, 'maya@northline.app', '$argon2id$stored')
      await ctx.users.create(user)

      const found = await ctx.users.findByEmailWithPassword(
        ctx.a.environmentId,
        'maya@northline.app'
      )
      expect(found?.passwordHash).toBe('$argon2id$stored')
      expect(found?.passwordChangedAt?.toISOString()).toBe(T0.toISOString())
      expect(found?.user.id).toBe(user.id)
      expect(await ctx.users.findByEmailWithPassword(ctx.a.environmentId, 'no@one.app')).toBeNull()
    })

    test('refuses a duplicate address, writes nothing and never calls beforeCommit', async () => {
      await ctx.users.create(newUser(ctx.a, 'maya@northline.app'))
      let called = false

      const second = newUser(ctx.a, 'MAYA@northline.app')
      const created = await ctx.users.create(second, async () => {
        called = true
      })

      expect(created).toBe(false)
      expect(called).toBe(false)
      expect(await ctx.users.findById(ctx.a.environmentId, second.id)).toBeNull()
    })

    test('the same address can exist in another environment, which cannot see the first', async () => {
      const first = newUser(ctx.a, 'maya@northline.app')
      expect(await ctx.users.create(first)).toBe(true)
      expect(await ctx.users.create(newUser(ctx.b, 'maya@northline.app'))).toBe(true)

      expect(await ctx.users.findById(ctx.b.environmentId, first.id)).toBeNull()
    })

    test('keeps nothing when beforeCommit fails, and the address stays free', async () => {
      const user = newUser(ctx.a, 'maya@northline.app')

      await expect(
        ctx.users.create(user, async () => {
          throw new Error('membership is down')
        })
      ).rejects.toThrow('membership is down')

      expect(await ctx.users.findById(ctx.a.environmentId, user.id)).toBeNull()
      expect(await ctx.users.findByEmail(ctx.a.environmentId, 'maya@northline.app')).toBeNull()
      expect(await ctx.users.create(newUser(ctx.a, 'maya@northline.app'))).toBe(true)
    })

    test('of concurrent creates for one address exactly one wins and runs beforeCommit', async () => {
      let committed = 0
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          ctx.users.create(newUser(ctx.a, 'race@northline.app'), async () => {
            committed += 1
          })
        )
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      expect(committed).toBe(1)
    })

    test('records the time of a sign-in', async () => {
      const user = newUser(ctx.a, 'maya@northline.app')
      await ctx.users.create(user)
      const at = new Date('2026-01-02T00:00:00Z')

      await ctx.users.recordSignIn(ctx.a.environmentId, user.id, at)

      expect((await ctx.users.findById(ctx.a.environmentId, user.id))?.lastSignInAt).toEqual(at)
    })

    test('replaces a hash only while it is the one that was verified, and keeps the password age', async () => {
      const user = newUser(ctx.a, 'maya@northline.app', '$argon2id$old')
      await ctx.users.create(user)
      const at = new Date('2026-02-01T00:00:00Z')

      expect(
        await ctx.users.upgradePasswordHash(
          ctx.a.environmentId,
          user.id,
          '$argon2id$other',
          'x',
          at
        )
      ).toBe(false)
      expect(
        await ctx.users.upgradePasswordHash(
          ctx.a.environmentId,
          user.id,
          '$argon2id$old',
          '$argon2id$new',
          at
        )
      ).toBe(true)

      const found = await ctx.users.findByEmailWithPassword(
        ctx.a.environmentId,
        'maya@northline.app'
      )
      expect(found?.passwordHash).toBe('$argon2id$new')
      expect(found?.passwordChangedAt?.toISOString()).toBe(T0.toISOString())
    })
  })
}
