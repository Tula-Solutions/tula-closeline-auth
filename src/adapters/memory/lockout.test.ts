import { describe, expect, test } from 'bun:test'
import { describeLockout, SUITE_LOCKOUT_POLICY } from '~/adapters/lockout.suite'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { CREDENTIAL_LOCKOUT, lockoutDelayMs } from '~/ports/lockout'

const policy = SUITE_LOCKOUT_POLICY

describe('lockoutDelayMs', () => {
  test.each([
    [1, 0],
    [3, 0],
    [4, 1_000],
    [5, 2_000],
    [6, 4_000],
    [7, 8_000],
    [8, 8_000],
    [5_000, 8_000],
  ])('%d failures → %d ms', (failures, expected) => {
    expect(lockoutDelayMs(policy, failures)).toBe(expected)
  })

  test('the credential policy gives 5 free tries, then 30s doubling to 15 minutes', () => {
    const delays = [5, 6, 7, 8, 9, 10, 11, 12].map((n) => lockoutDelayMs(CREDENTIAL_LOCKOUT, n))
    expect(delays).toEqual([0, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
  })
})

describeLockout('memory', async () => {
  const clock = new FixedClock()
  const lockout = new MemoryLockout(clock)
  return { lockout, peer: lockout, clock }
})

describe('MemoryLockout', () => {
  test('sweeps forgotten keys so memory stays bounded', async () => {
    const clock = new FixedClock()
    const lockout = new MemoryLockout(clock)
    for (let i = 0; i < 999; i++) {
      await lockout.attempt(`old-${i}`, policy, clock.now())
    }
    expect(lockout.size).toBe(999)
    clock.advance(60_000)
    await lockout.attempt('fresh', policy, clock.now())
    expect(lockout.size).toBe(1)
  })

  test('under key churn the map never grows past its cap', async () => {
    const clock = new FixedClock()
    const lockout = new MemoryLockout(clock, { maxKeys: 50 })

    for (let n = 0; n < 5_000; n++) {
      await lockout.attempt(`churn${n}`, policy, clock.now())
    }

    expect(lockout.size).toBeLessThanOrEqual(50)
  })

  test('a locked key stays locked however many other keys come through', async () => {
    const clock = new FixedClock()
    const lockout = new MemoryLockout(clock, { maxKeys: 50 })
    for (let n = 0; n < 4; n++) {
      await lockout.attempt('target', policy, clock.now())
    }
    expect((await lockout.attempt('target', policy, clock.now())).allowed).toBe(false)

    for (let n = 0; n < 5_000; n++) {
      await lockout.attempt(`churn${n}`, policy, clock.now())
    }

    expect((await lockout.attempt('target', policy, clock.now())).allowed).toBe(false)
  })

  test('a lockout full of locked keys refuses a new key and unlocks none of them early', async () => {
    const clock = new FixedClock()
    const lockout = new MemoryLockout(clock, { maxKeys: 50 })
    for (let n = 0; n < 50; n++) {
      for (let i = 0; i < 4; i++) {
        await lockout.attempt(`full${n}`, policy, clock.now())
      }
    }

    const newcomer = await lockout.attempt('newcomer', policy, clock.now())
    const again = await Promise.all(
      Array.from({ length: 50 }, (_, n) => lockout.attempt(`full${n}`, policy, clock.now()))
    )

    expect(newcomer.allowed).toBe(false)
    expect(newcomer.retryAfterMs).toBeGreaterThan(0)
    expect(again.some((decision) => decision.allowed)).toBe(false)
    expect(lockout.size).toBeLessThanOrEqual(50)
  })
})
