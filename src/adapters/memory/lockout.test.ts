import { describe, expect, test } from 'bun:test'
import { describeLockout, SUITE_LOCKOUT_POLICY } from '~/adapters/lockout.suite'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { CREDENTIAL_LOCKOUT, lockoutDelayMs } from '~/ports/lockout'
import { countMapIterations } from '~/testing/iterations'

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

  describe('at the cap, an insert does bounded work', () => {
    const KEYS = 5_000
    /** Far below the size of the map, far above what a bounded look at its front needs. */
    const BOUND = 300

    async function mostStepsPerInsert(
      fill: (lockout: MemoryLockout, clock: FixedClock) => Promise<void>
    ) {
      const clock = new FixedClock()
      const lockout = new MemoryLockout(clock, { maxKeys: KEYS })
      await fill(lockout, clock)
      expect(lockout.size).toBe(KEYS)
      let most = 0
      for (let n = 0; n < 200; n++) {
        const { steps } = await countMapIterations(() =>
          lockout.attempt(`newcomer${n}`, policy, clock.now())
        )
        most = Math.max(most, steps)
      }
      return most
    }

    test('a map full of keys that are not locked', async () => {
      const most = await mostStepsPerInsert(async (lockout, clock) => {
        for (let n = 0; n < KEYS; n++) {
          await lockout.attempt(`open${n}`, policy, clock.now())
        }
      })

      expect(most).toBeLessThan(BOUND)
    })

    test('a map full of locked keys, which refuses the newcomer', async () => {
      const most = await mostStepsPerInsert(async (lockout, clock) => {
        for (let n = 0; n < KEYS; n++) {
          for (let i = 0; i < 4; i++) {
            await lockout.attempt(`locked${n}`, policy, clock.now())
          }
        }
      })

      expect(most).toBeLessThan(BOUND)
    })

    test('a long run of locked keys at the front does not hide the keys behind it', async () => {
      const clock = new FixedClock()
      const lockout = new MemoryLockout(clock, { maxKeys: 500 })
      for (let n = 0; n < 200; n++) {
        for (let i = 0; i < 4; i++) {
          await lockout.attempt(`locked${n}`, policy, clock.now())
        }
      }
      for (let n = 0; n < 300; n++) {
        await lockout.attempt(`open${n}`, policy, clock.now())
      }

      const decisions = []
      for (let n = 0; n < 20; n++) {
        decisions.push((await lockout.attempt(`newcomer${n}`, policy, clock.now())).allowed)
      }

      // The map is full and the oldest 200 keys are locked: a few newcomers may be refused while
      // the scan moves past them, but then keys that are not locked are evicted for the rest.
      expect(decisions.filter(Boolean).length).toBeGreaterThanOrEqual(15)
    })
  })

  test('KNOWN LIMITATION: enough other keys evict a key that has failed, and its failures are forgotten', async () => {
    // The counters are per-process memory with a cap. A key below its lockout is evicted when
    // the cap is full of newer keys, so an attacker who can send that many cheap requests gets
    // fresh free tries on a victim. It goes away when the counters move to Postgres (hub issue
    // 30); this test pins the behaviour so a change to it is a decision, not an accident.
    const clock = new FixedClock()
    const lockout = new MemoryLockout(clock, { maxKeys: 100 })
    for (let n = 0; n < 3; n++) {
      expect((await lockout.attempt('victim', policy, clock.now())).allowed).toBe(true)
    }
    for (let n = 0; n < 100; n++) {
      await lockout.attempt(`churn${n}`, policy, clock.now())
    }

    const again = []
    for (let n = 0; n < 3; n++) {
      again.push((await lockout.attempt('victim', policy, clock.now())).allowed)
    }

    expect(again).toEqual([true, true, true])
  })

  test('KNOWN LIMITATION: a map full of locked keys refuses every new key until one unlocks', async () => {
    // The same cap, the other way round: locked keys are never evicted, so filling the map with
    // them denies sign-in to addresses nobody has tried yet. Fixed by the move to Postgres.
    const clock = new FixedClock()
    const lockout = new MemoryLockout(clock, { maxKeys: 50 })
    for (let n = 0; n < 50; n++) {
      for (let i = 0; i < 4; i++) {
        await lockout.attempt(`full${n}`, policy, clock.now())
      }
    }

    expect((await lockout.attempt('newcomer', policy, clock.now())).allowed).toBe(false)
    clock.advance(60_000)
    expect((await lockout.attempt('newcomer', policy, clock.now())).allowed).toBe(true)
  })
})
