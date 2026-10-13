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
 * Memory is bounded: at most `maxKeys` buckets. When full, expired buckets go first, then the
 * oldest bucket that has not reached its limit. A bucket that has is never evicted, so no key is
 * ever granted more tries than its limit by churn; if every bucket is like that, a new key is
 * refused (fails closed) until one of those windows ends.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, Window>()
  readonly #maxKeys: number
  #created = 0

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
   * Frees a slot for a new key if the map is full.
   *
   * @returns `null` when there is room, otherwise how long until a bucket at its limit ends.
   */
  #makeRoom(now: number): number | null {
    if (this.#windows.size < this.#maxKeys) {
      return null
    }
    this.#sweep(now)
    if (this.#windows.size < this.#maxKeys) {
      return null
    }
    let soonestEnd = Number.POSITIVE_INFINITY
    for (const [key, window] of this.#windows) {
      if (window.count < window.limit) {
        this.#windows.delete(key)
        return null
      }
      soonestEnd = Math.min(soonestEnd, window.startedAt + window.windowMs)
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
