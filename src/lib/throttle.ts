/** Lets an action through for a key at most once per window; see {@link createThrottle}. */
export interface Throttle {
  /** Whether `key` may act now. A `true` starts that key's window; a `false` changes nothing. */
  allow(key: string): boolean
}

/** Options for {@link createThrottle}. */
export type ThrottleOptions = {
  /** The shortest time between two `true` answers for one key. */
  windowMs: number
  /** The most keys remembered; past that the oldest are forgotten, which lets them act again. */
  maxKeys: number
  /** The current time in epoch milliseconds. */
  now: () => number
}

/**
 * A small once-per-window gate per key, for noise control (such as how often one kind of failure
 * is reported). **Best-effort and per process**: the state is in memory, so it resets on a restart
 * and each instance has its own, which is acceptable here because the worst case is a few extra
 * reports. It is never used for a decision that needs to be right (a limit on a person). Bounded:
 * at most `maxKeys` entries.
 */
export function createThrottle(options: ThrottleOptions): Throttle {
  const last = new Map<string, number>()
  return {
    allow(key) {
      const now = options.now()
      const before = last.get(key)
      if (before !== undefined && now - before < options.windowMs && now >= before) {
        return false
      }
      // Re-insert so the map stays in order of last use, and drop the oldest past the cap.
      last.delete(key)
      last.set(key, now)
      while (last.size > options.maxKeys) {
        const oldest = last.keys().next()
        if (oldest.done) {
          break
        }
        last.delete(oldest.value)
      }
      return true
    },
  }
}
