import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { withEnvironment } from 'tula-closeline-db'
import * as Bootstrap from '~/modules/bootstrap/service'
import { createPostgresDeps } from '~/testing/postgres-deps'
import { LONG_EXPIRED_MS, seeder } from './seed'
import * as Retention from './service'

let deps: Awaited<ReturnType<typeof createPostgresDeps>>

beforeAll(async () => {
  deps = await createPostgresDeps()
})
afterAll(() => deps.stop())

beforeEach(async () => {
  const tenant = Bootstrap.requireTenant(deps)
  await withEnvironment(deps.db, tenant.environmentId, (tx) =>
    tx.execute(sql`delete from auth.flow_attempts`)
  )
})

async function count(table: 'flow_attempts' | 'verification_tokens'): Promise<number> {
  const tenant = Bootstrap.requireTenant(deps)
  const result = await withEnvironment(deps.db, tenant.environmentId, (tx) =>
    tx.execute(sql.raw(`select count(*)::int as n from auth.${table}`))
  )
  return Number(result.rows[0]?.n)
}

function limited(limit: number) {
  const removed: number[] = []
  const wrap = <T extends { deleteExpired: (e: string, n: Date, l: number) => Promise<number> }>(
    store: T
  ): T =>
    Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      deleteExpired: async (environmentId: string, at: Date, size: number) => {
        const count = await store.deleteExpired(environmentId, at, size)
        removed.push(count)
        return count
      },
    })
  return {
    removed,
    deps: {
      ...deps,
      env: { ...deps.env, RETENTION_BATCH_SIZE: limit },
      flowAttempts: wrap(deps.flowAttempts),
      verificationTokens: wrap(deps.verificationTokens),
    },
  }
}

describe('retention against a real Postgres', () => {
  test('removes expired attempts and codes, at most the limit per statement, and keeps live rows', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    const seed = seeder(deps, tenant)
    await seed.attempts(12, LONG_EXPIRED_MS)
    await seed.tokens(7, LONG_EXPIRED_MS)
    await seed.tokens(2, -60_000)
    const { deps: bounded, removed } = limited(5)

    const result = await Retention.purgeExpired(bounded, tenant)

    expect(result).toEqual({ attempts: 12, tokens: 7, counters: 0, abandonCases: 0 })
    expect(Math.max(...removed)).toBeLessThanOrEqual(5)
    expect(await count('flow_attempts')).toBe(9)
    expect(await count('verification_tokens')).toBe(2)
  })

  test('a purged attempt takes its pending password hash with it', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    await seeder(deps, tenant).attempts(3, LONG_EXPIRED_MS)

    await Retention.runOnce(deps, tenant)

    expect(await count('flow_attempts')).toBe(0)
  })

  test('two instances running together: one purges, the other skips', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    await seeder(deps, tenant).attempts(4, LONG_EXPIRED_MS)
    let inner: Retention.RunOutcome | undefined

    const held = await deps.exclusive.runExclusive(Retention.RETENTION_LOCK, async () => {
      inner = await Retention.runOnce(deps, tenant)
    })

    expect(held).toBe(true)
    expect(inner).toBe('skipped')
    expect(await count('flow_attempts')).toBe(4)
    expect(await Retention.runOnce(deps, tenant)).toBe('purged')
    expect(await count('flow_attempts')).toBe(0)
  })

  test('the lock is released when the work throws, so the next run is not blocked', async () => {
    await expect(
      deps.exclusive.runExclusive(Retention.RETENTION_LOCK, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(await deps.exclusive.runExclusive(Retention.RETENTION_LOCK, async () => {})).toBe(true)
  })

  test('twelve runs at once purge every row exactly once between them', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    await seeder(deps, tenant).attempts(30, LONG_EXPIRED_MS)

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => Retention.runOnce(deps, tenant))
    )

    expect(outcomes.filter((outcome) => outcome === 'purged').length).toBeGreaterThanOrEqual(1)
    expect(outcomes.every((outcome) => outcome === 'purged' || outcome === 'skipped')).toBe(true)
    expect(await count('flow_attempts')).toBe(0)
  })
})
