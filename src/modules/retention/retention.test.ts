import { describe, expect, test } from 'bun:test'
import * as Bootstrap from '~/modules/bootstrap/service'
import { MEMBERSHIP_TIMEOUT_MS } from '~/modules/membership/service'
import { createReadyDeps } from '~/testing'
import { LONG_EXPIRED_MS, seeder } from './seed'
import * as Retention from './service'

async function setup(env: Record<string, string> = {}) {
  const deps = await createReadyDeps({ env: { RETENTION_BATCH_SIZE: '5', ...env } })
  const tenant = Bootstrap.requireTenant(deps)
  return { deps, tenant, seed: seeder(deps, tenant) }
}

/** Counts how many rows each purge statement removed. */
function recording<T extends { deleteExpired: (e: string, n: Date, l: number) => Promise<number> }>(
  store: T
) {
  const removed: number[] = []
  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
    deleteExpired: async (environmentId: string, at: Date, limit: number) => {
      const count = await store.deleteExpired(environmentId, at, limit)
      removed.push(count)
      return count
    },
  }) as T
  return { wrapped, removed }
}

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) {
      throw new Error('condition not met in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('purging expired sign-in data', () => {
  test('removes every expired attempt and code in batches no larger than the limit, and keeps live ones', async () => {
    const { deps, tenant, seed } = await setup()
    await seed.attempts(12, LONG_EXPIRED_MS)
    await seed.tokens(7, LONG_EXPIRED_MS)
    const [live] = await seed.attempts(1, -60_000)
    await seed.tokens(1, -60_000)
    const attempts = recording(deps.flowAttempts)
    const tokens = recording(deps.verificationTokens)

    const result = await Retention.purgeExpired(
      { ...deps, flowAttempts: attempts.wrapped, verificationTokens: tokens.wrapped },
      tenant
    )

    expect(result).toEqual({ attempts: 12, tokens: 7 })
    // A full batch means "again"; the first short one ends the loop.
    expect(attempts.removed).toEqual([5, 5, 2])
    expect(tokens.removed).toEqual([5, 2])
    expect(await deps.flowAttempts.findById(tenant.environmentId, live ?? '')).not.toBeNull()
    const again = await Retention.purgeExpired(deps, tenant)
    expect(again).toEqual({ attempts: 0, tokens: 0 })
  })

  test('an exact multiple of the limit takes one more, empty, statement to be sure', async () => {
    const { deps, tenant, seed } = await setup()
    await seed.attempts(10, LONG_EXPIRED_MS)
    const attempts = recording(deps.flowAttempts)

    await Retention.purgeExpired({ ...deps, flowAttempts: attempts.wrapped }, tenant)

    expect(attempts.removed).toEqual([5, 5, 0])
  })

  test('stops between batches once told to', async () => {
    const { deps, tenant, seed } = await setup()
    await seed.attempts(12, LONG_EXPIRED_MS)
    const controller = new AbortController()
    const attempts = recording(deps.flowAttempts)
    const stopping = {
      ...attempts.wrapped,
      deleteExpired: async (environmentId: string, at: Date, limit: number) => {
        const count = await attempts.wrapped.deleteExpired(environmentId, at, limit)
        controller.abort()
        return count
      },
    }

    const result = await Retention.purgeExpired(
      { ...deps, flowAttempts: stopping as typeof deps.flowAttempts },
      tenant,
      controller.signal
    )

    expect(result.attempts).toBe(5)
  })
})

describe('what a purge leaves for a sign-up still finishing', () => {
  test('keeps an attempt that expired within the time core is given to answer, and purges one expired longer ago', async () => {
    const { deps, tenant, seed } = await setup()
    const [justExpired] = await seed.attempts(1, 1_000)
    await seed.tokens(1, 1_000)
    const [longExpired] = await seed.attempts(1, LONG_EXPIRED_MS)

    const result = await Retention.purgeExpired(deps, tenant)

    expect(result.attempts).toBe(1)
    expect(await deps.flowAttempts.findById(tenant.environmentId, justExpired ?? '')).not.toBeNull()
    expect(await deps.flowAttempts.findById(tenant.environmentId, longExpired ?? '')).toBeNull()
  })

  test('the grace is twice the time core is given to answer', () => {
    expect(Retention.PURGE_GRACE_MS).toBe(2 * MEMBERSHIP_TIMEOUT_MS)
  })
})

describe('a run', () => {
  test('purges under the shared lock', async () => {
    const { deps, tenant, seed } = await setup()
    await seed.attempts(3, LONG_EXPIRED_MS)

    expect(await Retention.runOnce(deps, tenant)).toBe('purged')

    expect(await Retention.purgeExpired(deps, tenant)).toEqual({ attempts: 0, tokens: 0 })
  })

  test('is skipped, touching nothing, while another instance holds the lock', async () => {
    const { deps, tenant, seed } = await setup()
    await seed.attempts(3, LONG_EXPIRED_MS)
    let outcome: Retention.RunOutcome | undefined

    await deps.exclusive.runExclusive(Retention.RETENTION_LOCK, async () => {
      outcome = await Retention.runOnce(deps, tenant)
    })

    expect(outcome).toBe('skipped')
    expect(await Retention.purgeExpired(deps, tenant)).toEqual({ attempts: 3, tokens: 0 })
  })

  test('gives up after its timeout instead of hanging, and says so', async () => {
    const { deps, tenant } = await setup({ RETENTION_RUN_TIMEOUT_MS: '100' })
    const hung = {
      ...deps.flowAttempts,
      deleteExpired: () => new Promise<number>(() => {}),
    } as typeof deps.flowAttempts

    const outcome = await Retention.runOnce({ ...deps, flowAttempts: hung }, tenant)

    expect(outcome).toBe('timed_out')
    expect(deps.logLines.some((line) => line.includes('retention run timed out'))).toBe(true)
    expect(deps.reported).toHaveLength(1)
    expect(deps.reported[0]?.context).toMatchObject({ method: 'RETENTION', status: 500 })
  })

  test('a failure is logged without row data and reported as failed, not thrown', async () => {
    const { deps, tenant } = await setup()
    const broken = {
      ...deps.flowAttempts,
      deleteExpired: async () => {
        throw new Error('connection reset')
      },
    } as typeof deps.flowAttempts

    const outcome = await Retention.runOnce({ ...deps, flowAttempts: broken }, tenant)

    expect(outcome).toBe('failed')
    expect(deps.logLines.some((line) => line.includes('retention run failed'))).toBe(true)
  })

  test('a failure is also reported to the error tracker, with no row content', async () => {
    const { deps, tenant, seed } = await setup()
    await seed.attempts(3, LONG_EXPIRED_MS)
    const broken = {
      ...deps.flowAttempts,
      deleteExpired: async () => {
        throw new Error('connection reset')
      },
    } as typeof deps.flowAttempts

    await Retention.runOnce({ ...deps, flowAttempts: broken }, tenant)

    expect(deps.reported).toHaveLength(1)
    expect(deps.reported[0]?.context).toMatchObject({ method: 'RETENTION', status: 500 })
    const sent = JSON.stringify(
      deps.reported[0]?.error,
      Object.getOwnPropertyNames(deps.reported[0]?.error)
    )
    expect(sent).toContain('retention run failed')
    expect(sent).not.toContain('seed0@northline.app')
    expect(sent).not.toContain('argon2id')
  })

  test('a run that purges, or finds another instance holding the lock, reports nothing', async () => {
    const { deps, tenant, seed } = await setup()
    await seed.attempts(3, LONG_EXPIRED_MS)

    await Retention.runOnce(deps, tenant)
    await deps.exclusive.runExclusive(Retention.RETENTION_LOCK, async () => {
      await Retention.runOnce(deps, tenant)
    })

    expect(deps.reported).toHaveLength(0)
  })
})

describe('the schedule', () => {
  test('purges at boot and again on every interval, until stopped', async () => {
    const { deps, tenant, seed } = await setup({ RETENTION_INTERVAL_MS: '100' })
    await seed.attempts(3, LONG_EXPIRED_MS)
    const attempts = recording(deps.flowAttempts)

    const retention = Retention.start({ ...deps, flowAttempts: attempts.wrapped }, tenant)
    await waitFor(() => attempts.removed.length >= 3)
    await retention.stop()
    const runs = attempts.removed.length
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(attempts.removed[0]).toBe(3)
    expect(attempts.removed.slice(1).every((count) => count === 0)).toBe(true)
    expect(attempts.removed).toHaveLength(runs)
  })

  test('keeps going after a run fails', async () => {
    const { deps, tenant } = await setup({ RETENTION_INTERVAL_MS: '100' })
    let calls = 0
    const flaky = {
      ...deps.flowAttempts,
      deleteExpired: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('connection reset')
        }
        return 0
      },
    } as typeof deps.flowAttempts

    const retention = Retention.start({ ...deps, flowAttempts: flaky }, tenant)
    await waitFor(() => calls >= 3)
    await retention.stop()

    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test('stopping while a run is in progress waits for it and ends it', async () => {
    const { deps, tenant, seed } = await setup({ RETENTION_INTERVAL_MS: '100' })
    await seed.attempts(100, LONG_EXPIRED_MS)
    const batches = { started: 0 }
    const slow = {
      ...deps.flowAttempts,
      deleteExpired: async (environmentId: string, at: Date, limit: number) => {
        batches.started += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return deps.flowAttempts.deleteExpired(environmentId, at, limit)
      },
    } as typeof deps.flowAttempts
    const retention = Retention.start({ ...deps, flowAttempts: slow }, tenant)
    await waitFor(() => batches.started >= 1)

    await retention.stop()
    const startedAtStop = batches.started
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(batches.started).toBe(startedAtStop)
    expect(startedAtStop).toBeLessThan(20)
  })
})
