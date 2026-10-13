import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { describeRateLimiter } from '~/adapters/rate-limiter.suite'

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
})
