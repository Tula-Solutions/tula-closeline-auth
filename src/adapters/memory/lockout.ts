import type { Clock } from '~/ports/clock'
import {
  type Lockout,
  type LockoutDecision,
  type LockoutPolicy,
  lockoutDelayMs,
} from '~/ports/lockout'

interface Entry {
  failures: number
  lockedUntil: number
  /** When the failures stop counting. */
  forgetAt: number
}

/** Forgotten entries are swept after this many new keys, bounding memory under key churn. */
const SWEEP_EVERY = 1_000

/**
 * The most keys an insert at the cap looks at, so a full map costs a bounded amount per insert
 * however many keys it holds.
 */
const SCAN_LIMIT = 64

/** The most keys held at once; one is roughly 150 bytes, so this is about 8 MB. */
export const MAX_LOCKOUT_KEYS = 50_000

/** Options of {@link MemoryLockout}. */
export type MemoryLockoutOptions = {
  /** The most keys held at once (default {@link MAX_LOCKOUT_KEYS}). */
  maxKeys?: number
}

/**
 * Lockout state held in process memory.
 *
 * Correct for a single instance only: behind a load balancer each instance counts separately,
 * which multiplies the guesses an attacker gets. `RedisLockout` is the adapter for that; this
 * one is used when `REDIS_URL` is unset (`local` and `dev` only) and by unit tests.
 *
 * Memory is bounded: at most `maxKeys` keys. When full, the oldest key that is not locked right now
 * is evicted, looking at the front of the map only ({@link SCAN_LIMIT} keys), so an insert at the
 * cap does bounded work; the periodic sweep removes forgotten keys. A locked key is never
 * evicted, so churn cannot unlock it; when the keys looked at are all locked, a new key is
 * refused (fails closed) and the locked keys move to the back, so the next insert looks further.
 */
export class MemoryLockout implements Lockout {
  readonly #entries: Map<string, Entry>
  readonly #maxKeys: number
  #created: number
  /** While the clock is before this, every key is locked and a new key is refused outright. */
  #fullUntil: number

  /**
   * @param clock - Time source for sweeping forgotten keys.
   * @param options - Bounds; the default holds {@link MAX_LOCKOUT_KEYS} keys.
   */
  constructor(
    private readonly clock: Clock,
    options: MemoryLockoutOptions = {}
  ) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#entries = new Map()
    this.#maxKeys = options.maxKeys ?? MAX_LOCKOUT_KEYS
    this.#created = 0
    this.#fullUntil = 0
  }

  /** @inheritdoc */
  async attempt(key: string, policy: LockoutPolicy, now: Date): Promise<LockoutDecision> {
    const time = now.getTime()
    let entry = this.#entries.get(key)
    if (entry && time < entry.lockedUntil) {
      return { allowed: false, retryAfterMs: entry.lockedUntil - time }
    }
    if (!entry || time >= entry.forgetAt) {
      this.#entries.delete(key)
      this.#created += 1
      // Sweep before inserting: the new entry has no `forgetAt` yet and would sweep itself.
      if (this.#created % SWEEP_EVERY === 0) {
        this.#sweep()
      }
      const blockedFor = this.#makeRoom(time)
      if (blockedFor !== null) {
        return { allowed: false, retryAfterMs: blockedFor }
      }
      entry = { failures: 0, lockedUntil: 0, forgetAt: 0 }
      this.#entries.set(key, entry)
    }
    // No `await` between the check above and these writes, so concurrent attempts are counted
    // one at a time.
    entry.failures += 1
    entry.lockedUntil = time + lockoutDelayMs(policy, entry.failures)
    entry.forgetAt = Math.max(entry.lockedUntil, time) + policy.forgetAfterMs
    return { allowed: true, retryAfterMs: 0 }
  }

  /** @inheritdoc */
  async clear(key: string): Promise<void> {
    this.#entries.delete(key)
  }

  /** Number of keys held, including forgotten ones not yet swept (for tests). */
  get size(): number {
    return this.#entries.size
  }

  /**
   * Frees a slot for a new key if the map is full, looking at no more than {@link SCAN_LIMIT} keys.
   *
   * @returns `null` when there is room, otherwise how long until a locked key unlocks.
   */
  #makeRoom(time: number): number | null {
    if (this.#entries.size < this.#maxKeys) {
      return null
    }
    if (time < this.#fullUntil) {
      return this.#fullUntil - time
    }
    const skipped: string[] = []
    let soonestUnlock = Number.POSITIVE_INFINITY
    let evicted = false
    for (const [key, entry] of this.#entries) {
      if (time >= entry.lockedUntil) {
        this.#entries.delete(key)
        evicted = true
        break
      }
      skipped.push(key)
      soonestUnlock = Math.min(soonestUnlock, entry.lockedUntil)
      if (skipped.length >= SCAN_LIMIT) {
        break
      }
    }
    // Locked keys looked at go to the back, so the next insert starts past them.
    for (const key of skipped) {
      const entry = this.#entries.get(key)
      if (entry) {
        this.#entries.delete(key)
        this.#entries.set(key, entry)
      }
    }
    if (evicted) {
      return null
    }
    if (skipped.length >= this.#entries.size) {
      // Every key is locked: remember until when, so inserts until then cost nothing.
      // Only reachable when the map holds at most SCAN_LIMIT keys; a larger map never looks at all.
      this.#fullUntil = soonestUnlock
    }
    return Math.max(1, soonestUnlock - time)
  }

  #sweep(): void {
    const time = this.clock.now().getTime()
    for (const [key, entry] of this.#entries) {
      if (time >= entry.forgetAt) {
        this.#entries.delete(key)
      }
    }
  }
}
