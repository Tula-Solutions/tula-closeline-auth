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
 * Memory is bounded: at most `maxKeys` keys. When full, forgotten keys go first, then the oldest
 * key that is not locked right now. A locked key is never evicted, so churn cannot unlock it; if
 * every key is locked, a new key is refused (fails closed) until the first of them unlocks.
 */
export class MemoryLockout implements Lockout {
  readonly #entries: Map<string, Entry>
  readonly #maxKeys: number
  #created: number

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
   * Frees a slot for a new key if the map is full.
   *
   * @returns `null` when there is room, otherwise how long until a locked key unlocks.
   */
  #makeRoom(time: number): number | null {
    if (this.#entries.size < this.#maxKeys) {
      return null
    }
    this.#sweep()
    if (this.#entries.size < this.#maxKeys) {
      return null
    }
    let soonestUnlock = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.#entries) {
      if (time >= entry.lockedUntil) {
        this.#entries.delete(key)
        return null
      }
      soonestUnlock = Math.min(soonestUnlock, entry.lockedUntil)
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
