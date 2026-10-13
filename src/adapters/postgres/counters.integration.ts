import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { hmacSha256 } from '~/lib/hmac'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'
import { integrationTenants } from '~/testing/tenant'
import {
  createPostgresCounterPurger,
  createPostgresLockout,
  createPostgresRateLimiter,
} from './counters'

const KEY = 'integration-counter-key-0123456789abcdef'
const NOW = new Date()

const owner = ownerPool()
const handle = createDb(authUrl(), { max: 8 })
const { db } = handle

beforeAll(migrate)
afterAll(async () => {
  await handle.close()
  await owner.end()
})

let environmentId = ''
let otherEnvironmentId = ''

beforeEach(async () => {
  await resetAuthData(owner)
  const tenants = await integrationTenants(db)
  environmentId = tenants.a.environmentId
  otherEnvironmentId = tenants.b.environmentId
})

/** One API instance's adapters, over the shared table. */
function instance(key = KEY, environment: () => string = () => environmentId) {
  const options = { db, key, environmentId: environment }
  return {
    lockout: createPostgresLockout(options),
    limiter: createPostgresRateLimiter(options),
    purger: createPostgresCounterPurger(db),
  }
}

/** Moves every stored time back, so a wait or a window has passed (never by sleeping). */
async function age(seconds: number): Promise<void> {
  await owner.query(
    `update auth.attempt_counters
        set started_at = started_at - make_interval(secs => $1::float8),
            locked_until = locked_until - make_interval(secs => $1::float8),
            expires_at = expires_at - make_interval(secs => $1::float8)`,
    [seconds]
  )
}

async function rowCount(): Promise<number> {
  const result = await owner.query('select count(*)::int as n from auth.attempt_counters')
  return Number(result.rows[0]?.n)
}

describe('lockout in Postgres', () => {
  test('5 free tries, a 6th that starts a 30 second wait, then refusals with the time left', async () => {
    const { lockout } = instance()

    for (let n = 0; n < 6; n++) {
      expect(await lockout.attempt('address', CREDENTIAL_LOCKOUT, NOW)).toEqual({
        allowed: true,
        retryAfterMs: 0,
      })
    }
    const refused = await lockout.attempt('address', CREDENTIAL_LOCKOUT, NOW)

    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterMs).toBeGreaterThan(28_000)
    expect(refused.retryAfterMs).toBeLessThanOrEqual(30_000)
  })

  test('refused attempts are not counted: the next wait is the second, not an inflated one', async () => {
    const { lockout } = instance()
    for (let n = 0; n < 6; n++) {
      await lockout.attempt('address', CREDENTIAL_LOCKOUT, NOW)
    }
    for (let n = 0; n < 20; n++) {
      expect((await lockout.attempt('address', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(false)
    }

    await age(31)

    expect((await lockout.attempt('address', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(true)
    const next = await lockout.attempt('address', CREDENTIAL_LOCKOUT, NOW)
    expect(next.allowed).toBe(false)
    expect(next.retryAfterMs).toBeGreaterThan(58_000)
    expect(next.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  test('two instances share one budget: six tries split across them lock the next on both', async () => {
    const one = instance()
    const two = instance()

    for (let n = 0; n < 6; n++) {
      expect(
        (await (n % 2 === 0 ? one : two).lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)).allowed
      ).toBe(true)
    }

    expect((await one.lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(false)
    expect((await two.lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(false)
  })

  test('fifty concurrent attempts across two instances let exactly six through', async () => {
    const instances = [instance(), instance()]

    const decisions = await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        instances[n % 2]?.lockout.attempt('burst', CREDENTIAL_LOCKOUT, NOW)
      )
    )

    expect(decisions.filter((decision) => decision?.allowed)).toHaveLength(6)
  })

  test('a clear on one instance frees the other', async () => {
    const one = instance()
    const two = instance()
    for (let n = 0; n < 7; n++) {
      await one.lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)
    }

    await two.lockout.clear('a')

    expect((await one.lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(true)
    await two.lockout.clear('never seen')
  })

  test('failures are forgotten after the quiet period', async () => {
    const { lockout } = instance()
    for (let n = 0; n < 6; n++) {
      await lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)
    }

    // The 30 s wait and then an hour of quiet.
    await age(30 + 3_601)

    for (let n = 0; n < 6; n++) {
      expect((await lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(true)
    }
    expect((await lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(false)
  })

  test('keys and environments are independent', async () => {
    const here = instance()
    const there = instance(KEY, () => otherEnvironmentId)
    for (let n = 0; n < 7; n++) {
      await here.lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)
    }

    expect((await here.lockout.attempt('b', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(true)
    expect((await there.lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(true)
  })

  test('the table holds a 32-byte keyed hash, never the key it was made from', async () => {
    const { lockout } = instance()

    await lockout.attempt('sign_in:env:maya@northline.app', CREDENTIAL_LOCKOUT, NOW)

    const result = await owner.query(
      'select key_hash, kind, hits, row_to_json(c)::text as text from auth.attempt_counters c'
    )
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(
      Buffer.from(row.key_hash).equals(hmacSha256(KEY, 'sign_in:env:maya@northline.app'))
    ).toBe(true)
    expect(row.kind).toBe('lockout')
    expect(row.text).not.toContain('maya')
    expect(row.text).not.toContain(KEY)
  })

  test('another key hash key starts every counter again (rotation), and the old rows wait for the purge', async () => {
    const before = instance()
    const after = instance('rotated-counter-key-0123456789abcdefgh')
    for (let n = 0; n < 7; n++) {
      await before.lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)
    }

    expect((await after.lockout.attempt('a', CREDENTIAL_LOCKOUT, NOW)).allowed).toBe(true)

    expect(await rowCount()).toBe(2)
  })
})

describe('the rate limiter in Postgres', () => {
  test('allows up to the limit per window and counts the requests over it', async () => {
    const { limiter } = instance()

    const first = await limiter.hit('k', 2, 60_000)
    const second = await limiter.hit('k', 2, 60_000)
    const third = await limiter.hit('k', 2, 60_000)

    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, false])
    expect([first.remaining, second.remaining, third.remaining]).toEqual([1, 0, 0])
    expect(third.retryAfterMs).toBeGreaterThan(58_000)
    expect(third.retryAfterMs).toBeLessThanOrEqual(60_000)
    const stored = await owner.query('select hits from auth.attempt_counters')
    expect(stored.rows[0]?.hits).toBe(3)
  })

  test('a new window starts once the old one has ended', async () => {
    const { limiter } = instance()
    await limiter.hit('k', 1, 60_000)
    expect((await limiter.hit('k', 1, 60_000)).allowed).toBe(false)

    await age(61)

    expect((await limiter.hit('k', 1, 60_000)).allowed).toBe(true)
  })

  test('two instances share one window, and a burst across them is held to the limit', async () => {
    const instances = [instance(), instance()]

    const decisions = await Promise.all(
      Array.from({ length: 40 }, (_, n) => instances[n % 2]?.limiter.hit('burst', 10, 60_000))
    )

    expect(decisions.filter((decision) => decision?.allowed)).toHaveLength(10)
  })

  test('a lockout and a rate limit on the same key do not share a row', async () => {
    const { lockout, limiter } = instance()
    for (let n = 0; n < 7; n++) {
      await lockout.attempt('same', CREDENTIAL_LOCKOUT, NOW)
    }

    expect((await limiter.hit('same', 1, 60_000)).allowed).toBe(true)
  })
})

describe('the purge', () => {
  test('removes counters expired for over a minute in bounded batches across environments, and keeps the rest', async () => {
    const here = instance()
    const there = instance(KEY, () => otherEnvironmentId)
    for (let n = 0; n < 8; n++) {
      await here.limiter.hit(`old-${n}`, 1, 1_000)
    }
    for (let n = 0; n < 4; n++) {
      await there.lockout.attempt(`old-${n}`, CREDENTIAL_LOCKOUT, NOW)
    }
    await age(30 * 60 * 60)
    await here.limiter.hit('live', 1, 60_000)
    await here.limiter.hit('just-expired', 1, 1_000)
    await owner.query(
      `update auth.attempt_counters
          set started_at = started_at - interval '30 seconds', expires_at = expires_at - interval '30 seconds'
        where key_hash = $1`,
      [hmacSha256(KEY, 'just-expired')]
    )

    const removed: number[] = []
    for (;;) {
      const count = await here.purger.deleteExpired(5)
      removed.push(count)
      if (count < 5) {
        break
      }
    }

    expect(removed).toEqual([5, 5, 2])
    // The live row and the one that expired only seconds ago stay.
    expect(await rowCount()).toBe(2)
  })
})
