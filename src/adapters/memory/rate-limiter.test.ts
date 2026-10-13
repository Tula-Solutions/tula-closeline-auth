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
})
