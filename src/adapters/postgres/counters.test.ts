import { describe, expect, test } from 'bun:test'
import {
  COUNTER_PURGE_BATCH,
  createDb,
  type Database,
  LOCKOUT_ATTEMPT,
  LOCKOUT_CLEAR,
  LOCKOUT_MIN_RETRY_AFTER_MS,
  LOCKOUT_RETRY_AFTER,
  RATE_HIT,
} from 'tula-closeline-db'
import { hmacSha256 } from '~/lib/hmac'
import { CREDENTIAL_LOCKOUT, KNOWN_DEVICE_LOCKOUT, lockoutDelayMs } from '~/ports/lockout'
import {
  createPostgresCounterPurger,
  createPostgresLockout,
  createPostgresRateLimiter,
  poolOf,
} from './counters'

const ENVIRONMENT = '0194c0de-0000-7000-8000-000000000001'
const KEY = 'k'.repeat(40)

type Call = { text: string; values: unknown[] }

/** A database whose pool answers each query from a script, and remembers what it was asked. */
function fakeDatabase(answers: ({ rows: object[]; rowCount?: number } | Error)[]) {
  const calls: Call[] = []
  const pool = {
    async query(text: string, values: unknown[]) {
      calls.push({ text, values })
      const answer = answers.shift()
      if (answer === undefined) {
        throw new Error('unexpected query')
      }
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    },
  }
  return { db: { $client: pool } as unknown as Database, calls }
}

function lockoutOver(answers: Parameters<typeof fakeDatabase>[0]) {
  const { db, calls } = fakeDatabase(answers)
  const lockout = createPostgresLockout({ db, key: KEY, environmentId: () => ENVIRONMENT })
  return { lockout, calls }
}

const ROW = { rows: [{ hits: 1, wait_ms: 0 }] }
const NONE = { rows: [] }
const NOW = new Date()

describe('the Postgres lockout', () => {
  test('an attempt is one statement with the environment, a keyed hash, the schedule and the forgetting period', async () => {
    const { lockout, calls } = lockoutOver([ROW])

    const decision = await lockout.attempt('sign_in:env:abc', CREDENTIAL_LOCKOUT, NOW)

    expect(decision).toEqual({ allowed: true, retryAfterMs: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe(LOCKOUT_ATTEMPT)
    const [environment, hash, schedule, forget] = calls[0]?.values ?? []
    expect(environment).toBe(ENVIRONMENT)
    expect(hash).toEqual(hmacSha256(KEY, 'sign_in:env:abc'))
    expect((hash as Buffer).byteLength).toBe(32)
    expect(schedule).toEqual([0, 0, 0, 0, 0, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000])
    expect(forget).toBe(CREDENTIAL_LOCKOUT.forgetAfterMs)
  })

  test('the hash depends on the key, and the stored value holds neither the key nor the port key', async () => {
    const one = lockoutOver([ROW])
    const { db, calls } = fakeDatabase([ROW])
    const other = createPostgresLockout({
      db,
      key: 'j'.repeat(40),
      environmentId: () => ENVIRONMENT,
    })

    await one.lockout.attempt('sign_in:env:abc', CREDENTIAL_LOCKOUT, NOW)
    await other.attempt('sign_in:env:abc', CREDENTIAL_LOCKOUT, NOW)

    const first = one.calls[0]?.values[1] as Buffer
    const second = calls[0]?.values[1] as Buffer
    expect(first.equals(second)).toBe(false)
    expect(first.toString('latin1')).not.toContain('sign_in')
  })

  test.each([
    ['the credential policy', CREDENTIAL_LOCKOUT],
    ['the known-device policy', KNOWN_DEVICE_LOCKOUT],
    [
      'a short one',
      { freeAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000, forgetAfterMs: 60_000 },
    ],
    [
      'one that never waits',
      { freeAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 0, forgetAfterMs: 60_000 },
    ],
  ])(
    'the schedule for %s gives, for every failure count, the wait the memory adapter imposes',
    async (_name, policy) => {
      const { lockout, calls } = lockoutOver([ROW])
      await lockout.attempt('k', policy, NOW)
      const schedule = calls[0]?.values[2] as number[]

      // The statement serves failure n with element min(n, length): it must equal the policy.
      for (let failures = 1; failures <= 200; failures++) {
        expect(schedule[Math.min(failures, schedule.length) - 1]).toBe(
          lockoutDelayMs(policy, failures)
        )
      }
      expect(schedule.length).toBeLessThanOrEqual(policy.freeAttempts + 33)
    }
  )

  test('a refused attempt reads the retry time and answers locked with it', async () => {
    const { lockout, calls } = lockoutOver([NONE, { rows: [{ retry_after_ms: 4_321 }] }])

    const decision = await lockout.attempt('k', CREDENTIAL_LOCKOUT, NOW)

    expect(decision).toEqual({ allowed: false, retryAfterMs: 4_321 })
    expect(calls.map((call) => call.text)).toEqual([LOCKOUT_ATTEMPT, LOCKOUT_RETRY_AFTER])
    expect(calls[1]?.values).toEqual([ENVIRONMENT, calls[0]?.values[1]])
  })

  test.each([
    ['no row', NONE],
    ['a zero', { rows: [{ retry_after_ms: 0 }] }],
  ])(
    'when the retry read gives %s the attempt is run once more, and may then go ahead',
    async (_name, read) => {
      const { lockout, calls } = lockoutOver([NONE, read, ROW])

      const decision = await lockout.attempt('k', CREDENTIAL_LOCKOUT, NOW)

      expect(decision).toEqual({ allowed: true, retryAfterMs: 0 })
      expect(calls.map((call) => call.text)).toEqual([
        LOCKOUT_ATTEMPT,
        LOCKOUT_RETRY_AFTER,
        LOCKOUT_ATTEMPT,
      ])
    }
  )

  test.each([
    ['no row', NONE],
    ['a zero', { rows: [{ retry_after_ms: 0 }] }],
  ])(
    'when the second run is refused too (%s) it answers locked for at least the minimum, and runs no third',
    async (_name, read) => {
      const { lockout, calls } = lockoutOver([NONE, read, NONE])

      const decision = await lockout.attempt('k', CREDENTIAL_LOCKOUT, NOW)

      expect(decision).toEqual({ allowed: false, retryAfterMs: LOCKOUT_MIN_RETRY_AFTER_MS })
      expect(calls).toHaveLength(3)
    }
  )

  test('clear deletes the key in the environment', async () => {
    const { lockout, calls } = lockoutOver([{ rows: [] }])

    await lockout.clear('sign_in:env:abc')

    expect(calls).toEqual([
      { text: LOCKOUT_CLEAR, values: [ENVIRONMENT, hmacSha256(KEY, 'sign_in:env:abc')] },
    ])
  })

  test('a database error is never an allowed attempt', async () => {
    const { lockout } = lockoutOver([new Error('connection terminated')])

    await expect(lockout.attempt('k', CREDENTIAL_LOCKOUT, NOW)).rejects.toThrow(
      'connection terminated'
    )
  })

  test('before the environment is known an attempt throws and asks the database nothing', async () => {
    const { db, calls } = fakeDatabase([])
    const lockout = createPostgresLockout({
      db,
      key: KEY,
      environmentId: () => {
        throw new Error('the fixed project is not bootstrapped')
      },
    })

    await expect(lockout.attempt('k', CREDENTIAL_LOCKOUT, NOW)).rejects.toThrow('bootstrapped')
    expect(calls).toEqual([])
  })
})

describe('the Postgres rate limiter', () => {
  function limiterOver(answers: Parameters<typeof fakeDatabase>[0]) {
    const { db, calls } = fakeDatabase(answers)
    return {
      limiter: createPostgresRateLimiter({ db, key: KEY, environmentId: () => ENVIRONMENT }),
      calls,
    }
  }

  test('a hit is one statement; within the limit it is allowed with what remains', async () => {
    const { limiter, calls } = limiterOver([{ rows: [{ hits: 2, retry_after_ms: 59_000 }] }])

    const decision = await limiter.hit('orphan_report:x', 5, 60_000)

    expect(decision).toEqual({ allowed: true, remaining: 3, retryAfterMs: 59_000 })
    expect(calls).toEqual([
      { text: RATE_HIT, values: [ENVIRONMENT, hmacSha256(KEY, 'orphan_report:x'), 60_000] },
    ])
  })

  test('the request that reaches the limit is allowed with none left; one more is not', async () => {
    const { limiter } = limiterOver([
      { rows: [{ hits: 2, retry_after_ms: 1_000 }] },
      { rows: [{ hits: 3, retry_after_ms: 900 }] },
    ])

    expect(await limiter.hit('k', 2, 60_000)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterMs: 1_000,
    })
    expect(await limiter.hit('k', 2, 60_000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 900,
    })
  })

  test('a statement that returns no row is an error, never an allowed request', async () => {
    const { limiter } = limiterOver([NONE])

    await expect(limiter.hit('k', 2, 60_000)).rejects.toThrow('no row')
  })

  test('a database error is never an allowed request', async () => {
    const { limiter } = limiterOver([new Error('timeout')])

    await expect(limiter.hit('k', 2, 60_000)).rejects.toThrow('timeout')
  })
})

describe('the Postgres counter purger', () => {
  test('runs the bounded batch and returns how many rows it removed', async () => {
    const { db, calls } = fakeDatabase([{ rows: [], rowCount: 7 }])

    const removed = await createPostgresCounterPurger(db).deleteExpired(500)

    expect(removed).toBe(7)
    expect(calls).toEqual([{ text: COUNTER_PURGE_BATCH, values: [500] }])
  })
})

describe('the pool behind a database', () => {
  test('is the pool the db library built, found without connecting', async () => {
    const handle = createDb('postgres://u:p@127.0.0.1:1/closeline')

    expect(typeof poolOf(handle.db).query).toBe('function')
    await handle.close()
  })

  test('a handle without one is refused loudly', () => {
    expect(() => poolOf({} as unknown as Database)).toThrow('no pool')
  })
})
