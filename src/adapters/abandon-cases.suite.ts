import { beforeEach, describe, expect, test } from 'bun:test'
import type { AbandonCaseStore, NewAbandonCase } from '~/ports/abandon-cases'

/** What an abandon case store under test provides. */
export interface AbandonCaseSuiteContext {
  store: AbandonCaseStore
  /** Two environments of one project. */
  a: { projectId: string; environmentId: string }
  b: { projectId: string; environmentId: string }
  /** The store's own idea of now (the database's for Postgres, the fixed clock's for memory). */
  now: () => Date
  /** Lets `seconds` pass for every case of an environment (back-dates rows, never sleeps). */
  age: (environmentId: string, seconds: number) => Promise<void>
}

const ORG = () => `org_${crypto.randomUUID().replaceAll('-', '')}`

/**
 * Behaviour every `AbandonCaseStore` must have, run against the memory store and the table so the
 * double used by unit tests cannot drift from the statements.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeAbandonCases(name: string, setup: () => Promise<AbandonCaseSuiteContext>) {
  describe(`${name} (AbandonCaseStore)`, () => {
    let ctx: AbandonCaseSuiteContext
    beforeEach(async () => {
      ctx = await setup()
    })

    const input = (over: Partial<NewAbandonCase> = {}): NewAbandonCase => ({
      id: crypto.randomUUID(),
      projectId: ctx.a.projectId,
      environmentId: ctx.a.environmentId,
      organizationId: null,
      userId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      attemptExpiresAt: new Date(ctx.now().getTime() + 600_000),
      graceMs: 30_000,
      ...over,
    })
    const claim = (limit = 10, lease = 60_000) => ctx.store.claim(ctx.a.environmentId, limit, lease)

    test('records a case once per attempt and once per Organization', async () => {
      const org = ORG()
      const first = input({ organizationId: org })
      expect(await ctx.store.record(first)).toBe(true)
      expect(await ctx.store.record({ ...first, id: crypto.randomUUID() })).toBe(false)
      expect(await ctx.store.record(input({ organizationId: org }))).toBe(false)
      expect(await ctx.store.record(input({ attemptId: first.attemptId }))).toBe(false)
      // Cases without an Organization id coexist.
      expect(await ctx.store.record(input())).toBe(true)
      expect(await ctx.store.record(input())).toBe(true)
    })

    test('a case is not due until the attempt has expired and the grace has passed', async () => {
      await ctx.store.record(input())
      expect(await claim()).toEqual([])
      await ctx.age(ctx.a.environmentId, 600)
      expect(await claim()).toEqual([])
      await ctx.age(ctx.a.environmentId, 31)
      expect(await claim()).toHaveLength(1)
    })

    test('a grace below the floor is raised to it', async () => {
      await ctx.store.record(input({ graceMs: 1 }))
      await ctx.age(ctx.a.environmentId, 600 + 5)
      expect(await claim()).toEqual([])
      await ctx.age(ctx.a.environmentId, 6)
      expect(await claim()).toHaveLength(1)
    })

    test('a claim is a lease: counted, kept away from others, due again when it ends', async () => {
      const one = input()
      await ctx.store.record(one)
      await ctx.age(ctx.a.environmentId, 700)

      const [claimed] = await claim(10, 120_000)
      expect(claimed).toMatchObject({ id: one.id, userId: one.userId, attemptId: one.attemptId })
      expect(claimed?.attempts).toBe(1)
      expect(await claim()).toEqual([])

      await ctx.age(ctx.a.environmentId, 121)
      const [again] = await claim()
      expect(again?.attempts).toBe(2)
    })

    test('a claim is bounded and oldest first, and never crosses environments', async () => {
      for (let i = 0; i < 5; i += 1) {
        await ctx.store.record(input())
      }
      await ctx.store.record(
        input({ environmentId: ctx.b.environmentId, projectId: ctx.b.projectId })
      )
      await ctx.age(ctx.a.environmentId, 700)
      await ctx.age(ctx.b.environmentId, 700)

      expect(await claim(3)).toHaveLength(3)
      expect(await claim(10)).toHaveLength(2)
      expect(await ctx.store.claim(ctx.b.environmentId, 10, 60_000)).toHaveLength(1)
    })

    test('finds where a case stands: untouched, claimed, resolved, or none', async () => {
      const one = input()
      expect(await ctx.store.find(ctx.a.environmentId, one.id)).toBeNull()
      await ctx.store.record(one)
      expect(await ctx.store.find(ctx.a.environmentId, one.id)).toEqual({
        resolved: false,
        attempts: 0,
      })
      expect(await ctx.store.find(ctx.b.environmentId, one.id)).toBeNull()
      await ctx.age(ctx.a.environmentId, 700)
      await claim()
      expect(await ctx.store.find(ctx.a.environmentId, one.id)).toEqual({
        resolved: false,
        attempts: 1,
      })
      await ctx.store.resolve(ctx.a.environmentId, one.id, 'done')
      expect(await ctx.store.find(ctx.a.environmentId, one.id)).toEqual({
        resolved: true,
        attempts: 1,
      })
    })

    test('settling an untouched case means no claim can ever take it', async () => {
      const one = input()
      await ctx.store.record(one)

      expect(await ctx.store.settle(ctx.a.environmentId, one.id)).toBe(true)
      expect(await ctx.store.settle(ctx.a.environmentId, one.id)).toBe(false)
      await ctx.age(ctx.a.environmentId, 700)
      expect(await claim()).toEqual([])
    })

    test('a case the sweep claimed first cannot be settled', async () => {
      const one = input()
      await ctx.store.record(one)
      await ctx.age(ctx.a.environmentId, 700)
      expect(await claim()).toHaveLength(1)

      expect(await ctx.store.settle(ctx.a.environmentId, one.id)).toBe(false)
      expect(await ctx.store.settle(ctx.b.environmentId, one.id)).toBe(false)
      expect(await ctx.store.settle(ctx.a.environmentId, crypto.randomUUID())).toBe(false)
    })

    test('learns the Organization id once; another case holding it is a conflict', async () => {
      const first = input()
      const second = input()
      await ctx.store.record(first)
      await ctx.store.record(second)
      const org = ORG()

      expect(await ctx.store.learn(ctx.a.environmentId, first.id, org)).toBe('learned')
      expect(await ctx.store.learn(ctx.a.environmentId, first.id, ORG())).toBe('unchanged')
      expect(await ctx.store.learn(ctx.a.environmentId, second.id, org)).toBe('conflict')
      await ctx.age(ctx.a.environmentId, 700)
      const claimed = await claim()
      expect(claimed.find((row) => row.id === first.id)?.organizationId).toBe(org)
      expect(claimed.find((row) => row.id === second.id)?.organizationId).toBeNull()
    })

    test('resolves once; a resolved case is never claimed or learned', async () => {
      const one = input()
      await ctx.store.record(one)
      await ctx.age(ctx.a.environmentId, 700)

      expect(await ctx.store.resolve(ctx.a.environmentId, one.id, 'done')).toBe(true)
      expect(await ctx.store.resolve(ctx.a.environmentId, one.id, 'refused')).toBe(false)
      expect(await ctx.store.learn(ctx.a.environmentId, one.id, ORG())).toBe('unchanged')
      expect(await claim()).toEqual([])
      expect(await ctx.store.resolve(ctx.b.environmentId, one.id, 'done')).toBe(false)
    })

    test('gives up a case that used every attempt, and purges resolved cases after a day', async () => {
      const one = input()
      await ctx.store.record(one)
      await ctx.age(ctx.a.environmentId, 700)
      for (let i = 0; i < 100; i += 1) {
        expect(await claim(1, 1_000)).toHaveLength(1)
        await ctx.age(ctx.a.environmentId, 2)
      }
      expect(await claim()).toEqual([])

      expect(await ctx.store.giveUpSpent(ctx.a.environmentId, 10)).toEqual([one.id])
      expect(await ctx.store.giveUpSpent(ctx.a.environmentId, 10)).toEqual([])
      expect(await ctx.store.purgeResolved(ctx.a.environmentId, 10)).toBe(0)
      await ctx.age(ctx.a.environmentId, 2 * 86_400)
      expect(await ctx.store.purgeResolved(ctx.a.environmentId, 10)).toBe(1)
    })
  })
}
