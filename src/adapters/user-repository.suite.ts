import { beforeEach, describe, expect, test } from 'bun:test'
import type { FlowAttemptStore } from '~/ports/flow-attempt-store'
import type { NewGoogleUser, NewUser, UserRepository } from '~/ports/user-repository'

/** A tenant a repository under test runs in. */
export interface UserSuiteTenant {
  projectId: string
  environmentId: string
}

/** What a repository under test provides. */
export interface UserSuiteContext {
  users: UserRepository
  /** The attempt store the repository consumes a Google user's attempt in. */
  attempts: FlowAttemptStore
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

const PENDING_EXPIRES = new Date('2026-01-01T00:10:00Z')

function newGoogleUser(
  tenant: UserSuiteTenant,
  email: string,
  subject: string,
  attemptId: string
): NewGoogleUser {
  return {
    id: Bun.randomUUIDv7(),
    emailIdentityId: Bun.randomUUIDv7(),
    googleIdentityId: Bun.randomUUIDv7(),
    ...tenant,
    email,
    emailNormalized: email.toLowerCase(),
    emailVerifiedAt: T0,
    firstName: 'Maya',
    lastName: null,
    createdAt: T0,
    subject,
    consume: { id: attemptId, from: 'oidc_pending', at: T0, state: { client: 'web' } },
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

    test('refuses a duplicate address and writes nothing', async () => {
      await ctx.users.create(newUser(ctx.a, 'maya@northline.app'))

      const second = newUser(ctx.a, 'MAYA@northline.app')
      const created = await ctx.users.create(second)

      expect(created).toBe(false)
      expect(await ctx.users.findById(ctx.a.environmentId, second.id)).toBeNull()
    })

    test('creating the same user twice is refused the second time and leaves the first intact', async () => {
      const user = newUser(ctx.a, 'maya@northline.app')
      expect(await ctx.users.create(user)).toBe(true)

      expect(await ctx.users.create(user)).toBe(false)

      expect((await ctx.users.findById(ctx.a.environmentId, user.id))?.emailNormalized).toBe(
        'maya@northline.app'
      )
    })

    test('the same address can exist in another environment, which cannot see the first', async () => {
      const first = newUser(ctx.a, 'maya@northline.app')
      expect(await ctx.users.create(first)).toBe(true)
      expect(await ctx.users.create(newUser(ctx.b, 'maya@northline.app'))).toBe(true)

      expect(await ctx.users.findById(ctx.b.environmentId, first.id)).toBeNull()
    })

    test('of concurrent creates for one address exactly one wins', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => ctx.users.create(newUser(ctx.a, 'race@northline.app')))
      )

      expect(results.filter(Boolean)).toHaveLength(1)
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

    describe('Google accounts', () => {
      const pendingAttempt = async (tenant: UserSuiteTenant) => {
        const id = Bun.randomUUIDv7()
        await ctx.attempts.create({
          id,
          ...tenant,
          kind: 'sign_up',
          status: 'oidc_pending',
          userId: null,
          identifier: 'google:pending',
          secretHash: 'h',
          state: {},
          expiresAt: PENDING_EXPIRES,
          createdAt: T0,
        })
        return id
      }

      test('writes a user with no credential, both identities, and consumes the attempt', async () => {
        const attemptId = await pendingAttempt(ctx.a)
        const user = newGoogleUser(ctx.a, 'Maya@Northline.app', 'sub-1', attemptId)

        expect(await ctx.users.createGoogleUser(user)).toBe('created')

        const found = await ctx.users.findByGoogleSubject(ctx.a.environmentId, 'sub-1')
        expect(found?.id).toBe(user.id)
        const withPassword = await ctx.users.findByEmailWithPassword(
          ctx.a.environmentId,
          'maya@northline.app'
        )
        expect(withPassword?.passwordHash).toBeNull()
        expect(
          await ctx.users.findForGoogleLinking(ctx.a.environmentId, 'maya@northline.app')
        ).toMatchObject({ hasPassword: false, hasGoogle: true })
        const attempt = await ctx.attempts.findById(ctx.a.environmentId, attemptId)
        expect(attempt).toMatchObject({ status: 'complete', userId: user.id })
        expect(attempt?.completedAt).toEqual(T0)
      })

      test('writes nothing when the attempt was already consumed or has expired', async () => {
        const attemptId = await pendingAttempt(ctx.a)
        const first = newGoogleUser(ctx.a, 'one@northline.app', 'sub-a', attemptId)
        await ctx.users.createGoogleUser(first)

        const second = newGoogleUser(ctx.a, 'two@northline.app', 'sub-b', attemptId)
        expect(await ctx.users.createGoogleUser(second)).toBe('consumed')
        expect(await ctx.users.findById(ctx.a.environmentId, second.id)).toBeNull()
        expect(await ctx.users.findByGoogleSubject(ctx.a.environmentId, 'sub-b')).toBeNull()

        const late = await pendingAttempt(ctx.a)
        const expired = {
          ...newGoogleUser(ctx.a, 'late@northline.app', 'sub-c', late),
          consume: {
            id: late,
            from: 'oidc_pending' as const,
            at: new Date('2026-01-01T00:10:01Z'),
            state: {},
          },
        }
        expect(await ctx.users.createGoogleUser(expired)).toBe('consumed')
        expect(await ctx.users.findById(ctx.a.environmentId, expired.id)).toBeNull()
      })

      test('a taken address or Google account is a conflict and leaves the attempt usable', async () => {
        await ctx.users.create(newUser(ctx.a, 'taken@northline.app'))
        const attemptId = await pendingAttempt(ctx.a)

        const sameAddress = newGoogleUser(ctx.a, 'taken@northline.app', 'sub-d', attemptId)
        expect(await ctx.users.createGoogleUser(sameAddress)).toBe('conflict')
        expect((await ctx.attempts.findById(ctx.a.environmentId, attemptId))?.status).toBe(
          'oidc_pending'
        )

        await ctx.users.createGoogleUser(
          newGoogleUser(ctx.a, 'first@northline.app', 'sub-e', await pendingAttempt(ctx.a))
        )
        const sameSub = newGoogleUser(ctx.a, 'other@northline.app', 'sub-e', attemptId)
        expect(await ctx.users.createGoogleUser(sameSub)).toBe('conflict')
        expect(await ctx.users.findById(ctx.a.environmentId, sameSub.id)).toBeNull()
      })

      test('of concurrent writes for one attempt exactly one wins', async () => {
        const attemptId = await pendingAttempt(ctx.a)
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, n) =>
            ctx.users.createGoogleUser(
              newGoogleUser(ctx.a, `race${n}@northline.app`, `sub-race-${n}`, attemptId)
            )
          )
        )
        expect(results.filter((r) => r === 'created')).toHaveLength(1)
      })

      test('a Google account is found by sub in its own environment only', async () => {
        await ctx.users.createGoogleUser(
          newGoogleUser(ctx.a, 'maya@northline.app', 'sub-f', await pendingAttempt(ctx.a))
        )
        expect(await ctx.users.findByGoogleSubject(ctx.b.environmentId, 'sub-f')).toBeNull()
        expect(
          await ctx.users.findForGoogleLinking(ctx.b.environmentId, 'maya@northline.app')
        ).toBeNull()
      })

      test('links a Google account to an existing user once, and finds it by sub', async () => {
        const user = newUser(ctx.a, 'linked@northline.app')
        await ctx.users.create(user)
        const link = (userId: string, subject: string) => ({
          ...ctx.a,
          userId,
          identityId: Bun.randomUUIDv7(),
          subject,
          auditId: Bun.randomUUIDv7(),
          at: T0,
        })

        expect(
          await ctx.users.findForGoogleLinking(ctx.a.environmentId, 'linked@northline.app')
        ).toMatchObject({ hasPassword: true, hasGoogle: false })
        expect(await ctx.users.linkGoogle(link(user.id, 'sub-g'))).toBe(true)

        expect((await ctx.users.findByGoogleSubject(ctx.a.environmentId, 'sub-g'))?.id).toBe(
          user.id
        )
        expect(
          await ctx.users.findForGoogleLinking(ctx.a.environmentId, 'linked@northline.app')
        ).toMatchObject({ hasPassword: true, hasGoogle: true })
        expect(await ctx.users.linkGoogle(link(user.id, 'sub-h'))).toBe(false)
        const other = newUser(ctx.a, 'other@northline.app')
        await ctx.users.create(other)
        expect(await ctx.users.linkGoogle(link(other.id, 'sub-g'))).toBe(false)
        expect(await ctx.users.findByGoogleSubject(ctx.a.environmentId, 'sub-h')).toBeNull()
      })
    })
  })
}
