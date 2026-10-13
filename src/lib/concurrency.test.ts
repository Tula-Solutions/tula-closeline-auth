import { describe, expect, test } from 'bun:test'
import { createConcurrencyLimiter, createWorkLimits, Saturated } from './concurrency'

function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

describe('the concurrency limiter', () => {
  test('never runs more than its concurrency at once, and finishes everything in the queue', async () => {
    const limiter = createConcurrencyLimiter({ concurrency: 3, queue: 100 })
    let running = 0
    let peak = 0
    const work = async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 2))
      running -= 1
      return 'done'
    }

    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.run(work)))

    expect(results).toEqual(Array(50).fill('done'))
    expect(peak).toBe(3)
  })

  test('refuses at once when every slot and every queue place is taken', async () => {
    const limiter = createConcurrencyLimiter({ concurrency: 1, queue: 1 })
    const held = gate()
    const first = limiter.run(() => held.opened)
    const second = limiter.run(async () => 'queued')

    await expect(limiter.run(async () => 'too many')).rejects.toBeInstanceOf(Saturated)

    held.open()
    await first
    expect(await second).toBe('queued')
  })

  test('with no queue the second caller is refused while the first runs', async () => {
    const limiter = createConcurrencyLimiter({ concurrency: 1, queue: 0 })
    const held = gate()
    const first = limiter.run(() => held.opened)

    await expect(limiter.run(async () => 'x')).rejects.toBeInstanceOf(Saturated)

    held.open()
    await first
    expect(await limiter.run(async () => 'free again')).toBe('free again')
  })

  test('a slot is given back when the work throws', async () => {
    const limiter = createConcurrencyLimiter({ concurrency: 1, queue: 0 })

    await expect(
      limiter.run(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(await limiter.run(async () => 'ok')).toBe('ok')
  })

  test('serves the queue in order', async () => {
    const limiter = createConcurrencyLimiter({ concurrency: 1, queue: 5 })
    const held = gate()
    const order: number[] = []
    const first = limiter.run(() => held.opened)
    const rest = [1, 2, 3].map((n) => limiter.run(async () => void order.push(n)))

    held.open()
    await Promise.all([first, ...rest])

    expect(order).toEqual([1, 2, 3])
  })

  test('is sized from configuration', async () => {
    const limits = createWorkLimits({
      HASH_CONCURRENCY: 1,
      HASH_QUEUE: 0,
      BREACH_CHECK_CONCURRENCY: 2,
      BREACH_CHECK_QUEUE: 0,
    })
    const held = gate()
    const hashing = limits.hash.run(() => held.opened)

    await expect(limits.hash.run(async () => 1)).rejects.toBeInstanceOf(Saturated)
    expect(await limits.breach.run(async () => 2)).toBe(2)

    held.open()
    await hashing
  })
})
