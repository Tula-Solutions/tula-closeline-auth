import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { describeRateLimiter } from '~/adapters/rate-limiter.suite'
import { countMapIterations } from '~/testing/iterations'

describeRateLimiter('memory', async () => {
  const clock = new FixedClock()
  const limiter = new MemoryRateLimiter(clock)
  return { limiter, peer: limiter, clock }
})

describe('MemoryRateLimiter', () => {
  test('sweeps expired buckets so key churn cannot grow memory forever', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock)
    for (let n = 0; n < 1_500; n++) {
      await limiter.hit(`k${n}`, 1, 1_000)
    }
    clock.advance(5_000)
    for (let n = 0; n < 1_500; n++) {
      await limiter.hit(`j${n}`, 1, 1_000)
    }
    const fresh = await limiter.hit('k0', 1, 1_000)
    expect(fresh.allowed).toBe(true)
  })

  test('under key churn the map never grows past its cap', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock, { maxKeys: 50 })

    for (let n = 0; n < 5_000; n++) {
      await limiter.hit(`churn${n}`, 5, 3_600_000)
    }

    expect(limiter.size).toBeLessThanOrEqual(50)
  })

  test('a key that reached its limit stays blocked however many other keys come through', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock, { maxKeys: 50 })
    await limiter.hit('target', 2, 3_600_000)
    await limiter.hit('target', 2, 3_600_000)
    expect((await limiter.hit('target', 2, 3_600_000)).allowed).toBe(false)

    for (let n = 0; n < 5_000; n++) {
      await limiter.hit(`churn${n}`, 5, 3_600_000)
    }

    expect((await limiter.hit('target', 2, 3_600_000)).allowed).toBe(false)
  })

  test('a limiter full of keys at their limit refuses a new key and grants none of them more', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock, { maxKeys: 50 })
    for (let n = 0; n < 50; n++) {
      expect((await limiter.hit(`full${n}`, 1, 3_600_000)).allowed).toBe(true)
    }

    const newcomer = await limiter.hit('newcomer', 1, 3_600_000)
    const again = await Promise.all(
      Array.from({ length: 50 }, (_, n) => limiter.hit(`full${n}`, 1, 3_600_000))
    )

    expect(newcomer.allowed).toBe(false)
    expect(newcomer.retryAfterMs).toBeGreaterThan(0)
    expect(again.some((decision) => decision.allowed)).toBe(false)
    expect(limiter.size).toBeLessThanOrEqual(50)
  })

  test('a full limiter takes new keys again once old windows end', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock, { maxKeys: 50 })
    for (let n = 0; n < 50; n++) {
      await limiter.hit(`full${n}`, 1, 1_000)
    }
    clock.advance(2_000)

    expect((await limiter.hit('newcomer', 1, 1_000)).allowed).toBe(true)
  })

  test('a run of buckets at their limit at the front does not hide the buckets behind it', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock, { maxKeys: 500 })
    for (let n = 0; n < 100; n++) {
      await limiter.hit(`full${n}`, 1, 3_600_000)
    }
    for (let n = 0; n < 400; n++) {
      await limiter.hit(`open${n}`, 5, 3_600_000)
    }

    // An insert looks at 64 buckets, all at their limit, and refuses; they move to the back.
    const refused = await limiter.hit('newcomer0', 5, 3_600_000)
    // The next one starts past them, finds a bucket below its limit and evicts it.
    const accepted = await limiter.hit('newcomer1', 5, 3_600_000)

    expect(refused.allowed).toBe(false)
    expect(accepted.allowed).toBe(true)
  })

  test('when every bucket is at its limit and the map is small, refusals until one ends cost no scan', async () => {
    const clock = new FixedClock()
    const limiter = new MemoryRateLimiter(clock, { maxKeys: 50 })
    for (let n = 0; n < 50; n++) {
      await limiter.hit(`full${n}`, 1, 3_600_000)
    }

    const first = await countMapIterations(() => limiter.hit('newcomer0', 1, 3_600_000))
    const second = await countMapIterations(() => limiter.hit('newcomer1', 1, 3_600_000))
    clock.advance(3_600_000)
    const after = await limiter.hit('newcomer2', 1, 3_600_000)

    expect(first.result.allowed).toBe(false)
    expect(first.steps).toBeGreaterThan(0)
    expect(second.result.allowed).toBe(false)
    expect(second.steps).toBe(0)
    expect(after.allowed).toBe(true)
  })

  describe('at the cap, an insert does bounded work', () => {
    const KEYS = 5_000
    const BOUND = 300

    async function mostStepsPerInsert(limit: number) {
      const clock = new FixedClock()
      const limiter = new MemoryRateLimiter(clock, { maxKeys: KEYS })
      for (let n = 0; n < KEYS; n++) {
        for (let i = 0; i < limit; i++) {
          await limiter.hit(`full${n}`, limit, 3_600_000)
        }
      }
      expect(limiter.size).toBe(KEYS)
      let most = 0
      for (let n = 0; n < 200; n++) {
        const { steps } = await countMapIterations(() =>
          limiter.hit(`newcomer${n}`, limit, 3_600_000)
        )
        most = Math.max(most, steps)
      }
      return most
    }

    test('a map full of buckets below their limit', async () => {
      // The newcomers' own hits stay below the limit too: ask for a limit above the one filled to.
      const clock = new FixedClock()
      const limiter = new MemoryRateLimiter(clock, { maxKeys: KEYS })
      for (let n = 0; n < KEYS; n++) {
        await limiter.hit(`open${n}`, 5, 3_600_000)
      }
      let most = 0
      for (let n = 0; n < 200; n++) {
        const { steps } = await countMapIterations(() => limiter.hit(`newcomer${n}`, 5, 3_600_000))
        most = Math.max(most, steps)
      }

      expect(most).toBeLessThan(BOUND)
    })

    test('a map full of buckets at their limit, which refuses the newcomer', async () => {
      expect(await mostStepsPerInsert(1)).toBeLessThan(BOUND)
    })
  })
})
