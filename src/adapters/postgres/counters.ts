import type { Pool } from 'pg'
import {
  COUNTER_PURGE_BATCH,
  type Database,
  LOCKOUT_ATTEMPT,
  LOCKOUT_CLEAR,
  LOCKOUT_MIN_RETRY_AFTER_MS,
  LOCKOUT_RETRY_AFTER,
  RATE_HIT,
} from 'tula-closeline-db'
import { hmacSha256 } from '~/lib/hmac'
import type { CounterPurger } from '~/ports/counter-purger'
import {
  type Lockout,
  type LockoutDecision,
  type LockoutPolicy,
  lockoutDelayMs,
} from '~/ports/lockout'
import type { RateLimitDecision, RateLimiter } from '~/ports/rate-limiter'

/** What the Postgres counter adapters need. */
export type CounterStoreOptions = {
  /** The database; the statements run on its pool (the table has no row-level security). */
  db: Database
  /** The HMAC key (`COUNTER_HASH_KEY`): the table holds only hashes made with it. Never logged. */
  key: string
  /** The environment the deployment serves, read per call because it is known after boot. */
  environmentId: () => string
}

/**
 * The pool behind a database. The counter statements are parameterised SQL strings of the db
 * library, run as they are; Drizzle's `$client` is the pool it was built over (`createDb` passes
 * one), typed away by the library's `Database`.
 *
 * @throws Error when the database was not built over a pool.
 */
export function poolOf(db: Database): Pool {
  const pool = (db as unknown as { $client?: Pool }).$client
  if (typeof pool?.query !== 'function') {
    throw new Error('the database handle has no pool to run the counter statements on')
  }
  return pool
}

/** The result row of {@link LOCKOUT_ATTEMPT}, which this adapter reads only for its presence. */
type AttemptRow = { hits: number; wait_ms: number }
type RetryRow = { retry_after_ms: number }
type RateRow = { hits: number; retry_after_ms: number }

/**
 * The waits after failure 1, 2, 3, ... for a policy, ending at the first wait that is the
 * longest (the statement serves every later failure with the last element), so the schedule
 * stays in the service and agrees with {@link lockoutDelayMs}.
 */
const schedules = new WeakMap<LockoutPolicy, number[]>()
function scheduleFor(policy: LockoutPolicy): number[] {
  const known = schedules.get(policy)
  if (known) {
    return known
  }
  const waits: number[] = []
  // The delay doubles, so it reaches the maximum within 31 steps past the free attempts.
  for (let failures = 1; failures <= policy.freeAttempts + 32; failures++) {
    const wait = lockoutDelayMs(policy, failures)
    waits.push(wait)
    if (wait >= policy.maxDelayMs) {
      break
    }
  }
  schedules.set(policy, waits)
  return waits
}

/** The 32-byte hash that stands for a port key in the table. */
function hashOf(options: CounterStoreOptions, key: string): Buffer {
  return hmacSha256(options.key, key)
}

/**
 * Lockout in the shared `auth.attempt_counters` table (hub issue 30, ADR 0014): every instance
 * counts against one row per key, so the guessing budget does not depend on how many run or when
 * they restarted. The database clock decides; the `now` argument is ignored. A database error
 * propagates, so an attempt is never allowed uncounted.
 */
export function createPostgresLockout(options: CounterStoreOptions): Lockout {
  const run = async <Row extends object>(text: string, values: unknown[]): Promise<Row[]> =>
    (await poolOf(options.db).query<Row>(text, values)).rows

  return {
    async attempt(key, policy): Promise<LockoutDecision> {
      const environmentId = options.environmentId()
      const hash = hashOf(options, key)
      const attemptOnce = async (): Promise<boolean> =>
        (
          await run<AttemptRow>(LOCKOUT_ATTEMPT, [
            environmentId,
            hash,
            scheduleFor(policy),
            policy.forgetAfterMs,
          ])
        ).length > 0

      if (await attemptOnce()) {
        return { allowed: true, retryAfterMs: 0 }
      }
      const [row] = await run<RetryRow>(LOCKOUT_RETRY_AFTER, [environmentId, hash])
      const wait = row?.retry_after_ms ?? 0
      if (wait > 0) {
        return { allowed: false, retryAfterMs: wait }
      }
      // The lock ended or the row was cleared between the two statements: count once more.
      if (await attemptOnce()) {
        return { allowed: true, retryAfterMs: 0 }
      }
      return { allowed: false, retryAfterMs: LOCKOUT_MIN_RETRY_AFTER_MS }
    },

    async clear(key) {
      await run(LOCKOUT_CLEAR, [options.environmentId(), hashOf(options, key)])
    },
  }
}

/**
 * The per-key fixed-window limiter in the shared `auth.attempt_counters` table. Requests over the
 * limit are counted too, as the memory limiter does. The database clock decides.
 */
export function createPostgresRateLimiter(options: CounterStoreOptions): RateLimiter {
  return {
    async hit(key, limit, windowMs): Promise<RateLimitDecision> {
      const result = await poolOf(options.db).query<RateRow>(RATE_HIT, [
        options.environmentId(),
        hashOf(options, key),
        windowMs,
      ])
      const row = result.rows[0]
      if (!row) {
        // The statement always returns the row it wrote; no row means it did not count.
        throw new Error('the rate-limit statement returned no row')
      }
      const allowed = row.hits <= limit
      return {
        allowed,
        remaining: allowed ? limit - row.hits : 0,
        retryAfterMs: row.retry_after_ms,
      }
    },
  }
}

/** Purges expired counters one bounded batch at a time, across environments. */
export function createPostgresCounterPurger(db: Database): CounterPurger {
  return {
    async deleteExpired(limit) {
      const result = await poolOf(db).query(COUNTER_PURGE_BATCH, [limit])
      return result.rowCount ?? 0
    },
  }
}
