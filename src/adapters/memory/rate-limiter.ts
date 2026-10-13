import type { Clock } from '~/ports/clock'
import type { RateLimitDecision, RateLimiter } from '~/ports/rate-limiter'

interface Window {
  startedAt: number
  count: number
  windowMs: number
  limit: number
}

/** Expired windows are swept after this many new buckets, bounding memory under key churn. */
const SWEEP_EVERY = 1_000

/**
 * The most buckets an insert at the cap looks at, so a full map costs a bounded amount per insert
 * however many buckets it holds.
 */
const SCAN_LIMIT = 64

/** The most buckets held at once; one is roughly 200 bytes, so this is about 10 MB. */
export const MAX_RATE_LIMIT_KEYS = 50_000

/** Options of {@link MemoryRateLimiter}. */
export type MemoryRateLimiterOptions = {
  /** The most buckets held at once (default {@link MAX_RATE_LIMIT_KEYS}). */
  maxKeys?: number
}

/**
 * Fixed-window counter held in process memory.
 *
 * Correct for a single instance only: behind a load balancer each instance counts separately,
 * which multiplies the effective limit. No shared store exists for it yet (it needs a table or a
 * cache, which is a schema decision), so this is what the container uses and the gap is reported.
 *
 * Memory is bounded: at most `maxKeys` buckets. When full, the oldest bucket that is expired or
 * has not reached its limit is evicted, looking at the front of the map only
 * ({@link SCAN_LIMIT} buckets), so an insert at the cap does bounded work; the periodic sweep
 * removes expired buckets. A bucket at its limit is never evicted, so no key is ever granted more
 * tries than its limit by churn; when the buckets looked at are all like that, a new key is
 * refused (fails closed) and they move to the back, so the next insert looks further.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, Window>()
  readonly #maxKeys: number
  #created = 0
  /** While the clock is before this, every bucket is at its limit and a new key is refused. */
  #fullUntil = 0

  /**
   * @param clock - Time source for window boundaries.
   * @param options - Bounds; the default holds {@link MAX_RATE_LIMIT_KEYS} buckets.
   */
  constructor(
    private readonly clock: Clock,
    options: MemoryRateLimiterOptions = {}
  ) {
    this.#maxKeys = options.maxKeys ?? MAX_RATE_LIMIT_KEYS
  }

  /** @inheritdoc */
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime()
    let window = this.#windows.get(key)
    if (window && now - window.startedAt >= window.windowMs) {
      this.#windows.delete(key)
      window = undefined
    }
    if (!window) {
      this.#created += 1
      if (this.#created % SWEEP_EVERY === 0) {
        this.#sweep(now)
      }
      const blockedFor = this.#makeRoom(now)
      if (blockedFor !== null) {
        return { allowed: false, remaining: 0, retryAfterMs: blockedFor }
      }
      window = { startedAt: now, count: 0, windowMs, limit }
      this.#windows.set(key, window)
    }
    window.count += 1
    const retryAfterMs = window.startedAt + window.windowMs - now
    const allowed = window.count <= limit
    return { allowed, remaining: allowed ? limit - window.count : 0, retryAfterMs }
  }

  /** Number of live buckets; exposed for tests of the sweep. */
  get size(): number {
    return this.#windows.size
  }

  /**
   * Frees a slot for a new key if the map is full, looking at no more than {@link SCAN_LIMIT}
   * buckets.
   *
   * @returns `null` when there is room, otherwise how long until a bucket at its limit ends.
   */
  #makeRoom(now: number): number | null {
    if (this.#windows.size < this.#maxKeys) {
      return null
    }
    if (now < this.#fullUntil) {
      return this.#fullUntil - now
    }
    const skipped: string[] = []
    let soonestEnd = Number.POSITIVE_INFINITY
    let evicted = false
    for (const [key, window] of this.#windows) {
      const endsAt = window.startedAt + window.windowMs
      if (now >= endsAt || window.count < window.limit) {
        this.#windows.delete(key)
        evicted = true
        break
      }
      skipped.push(key)
      soonestEnd = Math.min(soonestEnd, endsAt)
      if (skipped.length >= SCAN_LIMIT) {
        break
      }
    }
    // Buckets at their limit that were looked at go to the back, so the next insert starts past them.
    for (const key of skipped) {
      const window = this.#windows.get(key)
      if (window) {
        this.#windows.delete(key)
        this.#windows.set(key, window)
      }
    }
    if (evicted) {
      return null
    }
    if (skipped.length >= this.#windows.size) {
      // Every bucket is at its limit: remember until when, so inserts until then cost nothing.
      this.#fullUntil = soonestEnd
    }
    return Math.max(1, soonestEnd - now)
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt >= window.windowMs) {
        this.#windows.delete(key)
      }
    }
  }
}
