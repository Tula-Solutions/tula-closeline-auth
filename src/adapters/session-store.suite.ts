import { beforeEach, describe, expect, test } from 'bun:test'
import type { NewRefreshToken, NewSession, SessionStore } from '~/ports/session-store'

/** A tenant plus the user rows the sessions' foreign keys need. */
export interface SessionSuiteTenant {
  projectId: string
  environmentId: string
  /** Creates a user (a real row for Postgres) and returns its id. */
  user: () => Promise<string>
}

/** What a store under test provides. */
export interface SessionSuiteContext {
  store: SessionStore
  a: SessionSuiteTenant
  b: SessionSuiteTenant
}

const T0 = new Date('2026-01-01T00:00:00Z')
const HOUR = 3_600_000
const SEALED = new Uint8Array([1, 2, 3, 250, 0, 7])

function session(tenant: SessionSuiteTenant, userId: string, createdAt = T0): NewSession {
  return {
    id: Bun.randomUUIDv7(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    userId,
    client: 'ios',
    lastActiveAt: createdAt,
    idleExpiresAt: new Date(createdAt.getTime() + HOUR),
    absoluteExpiresAt: new Date(createdAt.getTime() + 24 * HOUR),
    factorVerifiedAt: createdAt,
    authMethods: ['pwd'],
    createdAt,
  }
}

function token(s: NewSession, hash: string, parentId: string | null = null): NewRefreshToken {
  return {
    id: Bun.randomUUIDv7(),
    projectId: s.projectId,
    environmentId: s.environmentId,
    sessionId: s.id,
    tokenHash: hash,
    parentId,
    expiresAt: s.idleExpiresAt,
    createdAt: s.createdAt,
  }
}

/** Behaviour every `SessionStore` has, memory included (one suite, each adapter). */
export function sessionStoreSuite(name: string, setup: () => Promise<SessionSuiteContext>): void {
  describe(`${name} (SessionStore)`, () => {
    let ctx: SessionSuiteContext
    beforeEach(async () => {
      ctx = await setup()
    })

    async function start() {
      const userId = await ctx.a.user()
      const s = session(ctx.a, userId)
      const root = token(s, `hash-${s.id}`)
      await ctx.store.create(s, root)
      return { userId, s, root }
    }

    test('stores a session with its first token and finds both by the token hash', async () => {
      const { s, root } = await start()

      const found = await ctx.store.findToken(ctx.a.environmentId, root.tokenHash)

      expect(found?.session.id).toBe(s.id)
      expect(found?.session.authMethods).toEqual(['pwd'])
      expect(found?.session.revokedAt).toBeNull()
      expect(found?.token.usedAt).toBeNull()
      expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.userId).toBe(s.userId)
      expect(await ctx.store.findToken(ctx.a.environmentId, 'unknown')).toBeNull()
    })

    test('another environment cannot see the session or its tokens', async () => {
      const { s, root } = await start()

      expect(await ctx.store.findById(ctx.b.environmentId, s.id)).toBeNull()
      expect(await ctx.store.findToken(ctx.b.environmentId, root.tokenHash)).toBeNull()
      expect(await ctx.store.findTokenById(ctx.b.environmentId, root.id)).toBeNull()
    })

    test('rotation spends the parent, links the child and moves the idle expiry', async () => {
      const { s, root } = await start()
      const at = new Date(T0.getTime() + 1_000)
      const child = token(s, 'child-hash', root.id)

      const rotated = await ctx.store.rotate(ctx.a.environmentId, {
        parentId: root.id,
        child,
        at,
        idleExpiresAt: new Date(at.getTime() + HOUR),
        sealedNextToken: SEALED,
      })

      expect(rotated).toBe(true)
      const parent = await ctx.store.findTokenById(ctx.a.environmentId, root.id)
      expect(parent?.usedAt).toEqual(at)
      expect(parent?.replacedById).toBe(child.id)
      const moved = await ctx.store.findById(ctx.a.environmentId, s.id)
      expect(moved?.idleExpiresAt).toEqual(new Date(at.getTime() + HOUR))
      expect(moved?.lastActiveAt).toEqual(at)
    })

    test('rotation seals the next token on the spent row; only its own environment reads it', async () => {
      const { s, root } = await start()
      const at = new Date(T0.getTime() + 1_000)
      await ctx.store.rotate(ctx.a.environmentId, {
        parentId: root.id,
        child: token(s, 'child-hash', root.id),
        at,
        idleExpiresAt: new Date(at.getTime() + HOUR),
        sealedNextToken: SEALED,
      })

      const spent = await ctx.store.findTokenById(ctx.a.environmentId, root.id)

      expect(Array.from(spent?.sealedNextToken ?? [])).toEqual(Array.from(SEALED))
      expect(await ctx.store.findTokenById(ctx.b.environmentId, root.id)).toBeNull()
      await ctx.store.clearSealedNextToken(ctx.b.environmentId, root.id)
      expect(
        (await ctx.store.findTokenById(ctx.a.environmentId, root.id))?.sealedNextToken
      ).not.toBeNull()
    })

    test('clearing sets the sealed value to NULL, and the next rotation clears the one before it', async () => {
      const { s, root } = await start()
      const at = new Date(T0.getTime() + 1_000)
      const rotation = (parentId: string, hash: string) => ({
        parentId,
        child: token(s, hash, parentId),
        at,
        idleExpiresAt: new Date(at.getTime() + HOUR),
        sealedNextToken: SEALED,
      })
      const first = rotation(root.id, 'c1')
      await ctx.store.rotate(ctx.a.environmentId, first)
      await ctx.store.clearSealedNextToken(ctx.a.environmentId, root.id)
      expect(
        (await ctx.store.findTokenById(ctx.a.environmentId, root.id))?.sealedNextToken
      ).toBeNull()

      const second = rotation(first.child.id, 'c2')
      await ctx.store.rotate(ctx.a.environmentId, second)
      const third = rotation(second.child.id, 'c3')
      await ctx.store.rotate(ctx.a.environmentId, third)

      const middle = await ctx.store.findTokenById(ctx.a.environmentId, first.child.id)
      const latest = await ctx.store.findTokenById(ctx.a.environmentId, second.child.id)
      expect(middle?.sealedNextToken).toBeNull()
      expect(latest?.sealedNextToken).not.toBeNull()
    })

    test('of concurrent rotations of one token exactly one wins', async () => {
      const { s, root } = await start()
      const at = new Date(T0.getTime() + 1_000)

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          ctx.store.rotate(ctx.a.environmentId, {
            parentId: root.id,
            child: token(s, 'same-child-hash', root.id),
            at,
            idleExpiresAt: new Date(at.getTime() + HOUR),
            sealedNextToken: SEALED,
          })
        )
      )

      expect(results.filter(Boolean)).toHaveLength(1)
    })

    test('a spent token cannot be rotated again, and a revoked session cannot rotate', async () => {
      const { s, root } = await start()
      const at = new Date(T0.getTime() + 1_000)
      const next = (hash: string, parentId: string) => ({
        parentId,
        child: token(s, hash, parentId),
        at,
        idleExpiresAt: new Date(at.getTime() + HOUR),
        sealedNextToken: SEALED,
      })
      const first = next('c1', root.id)
      expect(await ctx.store.rotate(ctx.a.environmentId, first)).toBe(true)
      expect(await ctx.store.rotate(ctx.a.environmentId, next('c1b', root.id))).toBe(false)

      await ctx.store.revoke(ctx.a.environmentId, s.id, 'sign_out', at)

      expect(await ctx.store.rotate(ctx.a.environmentId, next('c2', first.child.id))).toBe(false)
      expect(await ctx.store.findToken(ctx.a.environmentId, 'c1b')).toBeNull()
    })

    test('revoking ends the session once and records why', async () => {
      const { s } = await start()
      const at = new Date(T0.getTime() + 5_000)

      expect(await ctx.store.revoke(ctx.a.environmentId, s.id, 'reuse_detected', at)).toBe(true)
      expect(await ctx.store.revoke(ctx.a.environmentId, s.id, 'sign_out', at)).toBe(false)

      const ended = await ctx.store.findById(ctx.a.environmentId, s.id)
      expect(ended?.revokedAt).toEqual(at)
      expect(ended?.revokeReason).toBe('reuse_detected')
      expect(await ctx.store.revoke(ctx.b.environmentId, s.id, 'sign_out', at)).toBe(false)
    })

    test('lists a user’s usable sessions newest first, a page at a time', async () => {
      const userId = await ctx.a.user()
      const made: NewSession[] = []
      for (let n = 0; n < 5; n++) {
        const s = session(ctx.a, userId, new Date(T0.getTime() + n * 1_000))
        await ctx.store.create(s, token(s, `list-${n}-${s.id}`))
        made.push(s)
      }
      const ids = made.map((m) => m.id)
      const [endedId, ...alive] = ids
      await ctx.store.revoke(ctx.a.environmentId, endedId ?? '', 'sign_out', T0)
      const now = new Date(T0.getTime() + 10_000)

      const first = await ctx.store.listActive(ctx.a.environmentId, userId, now, 2)
      const second = await ctx.store.listActive(ctx.a.environmentId, userId, now, 2, {
        createdAt: first[1]?.createdAt ?? now,
        id: first[1]?.id ?? '',
      })

      expect(first.map((x) => x.id)).toEqual([alive[3] ?? '', alive[2] ?? ''])
      expect(second.map((x) => x.id)).toEqual([alive[1] ?? '', alive[0] ?? ''])
    })

    test('does not list sessions that idled out, other users’ or other environments’', async () => {
      const userId = await ctx.a.user()
      const stale = session(ctx.a, userId)
      await ctx.store.create(stale, token(stale, `stale-${stale.id}`))
      const other = await ctx.a.user()
      const theirs = session(ctx.a, other)
      await ctx.store.create(theirs, token(theirs, `theirs-${theirs.id}`))
      const later = new Date(T0.getTime() + 2 * HOUR)

      expect(await ctx.store.listActive(ctx.a.environmentId, userId, later, 10)).toEqual([])
      expect(await ctx.store.listActive(ctx.b.environmentId, userId, T0, 10)).toEqual([])
      expect(
        (await ctx.store.listActive(ctx.a.environmentId, other, T0, 10)).map((x) => x.id)
      ).toEqual([theirs.id])
    })
  })
}
