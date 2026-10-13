/** Thrown by a {@link ConcurrencyLimiter} when its slots and its queue are all taken. */
export class Saturated extends Error {
  constructor() {
    super('the concurrency limit is reached')
    this.name = 'Saturated'
  }
}

/** Runs work with at most a fixed number in flight at once and a bounded line behind them. */
export interface ConcurrencyLimiter {
  /**
   * Runs `work` when a slot is free, after waiting in the queue if one is available.
   *
   * @throws Saturated at once when every slot and every queue place is taken.
   */
  run<T>(work: () => Promise<T>): Promise<T>
}

/** How many run at once and how many may wait for a slot. */
export type ConcurrencyOptions = { concurrency: number; queue: number }

/**
 * A counting semaphore with a bounded queue. Admission is first come, first served; a caller
 * past the queue is refused immediately instead of piling up memory behind slow work.
 */
export function createConcurrencyLimiter(options: ConcurrencyOptions): ConcurrencyLimiter {
  let active = 0
  const waiting: (() => void)[] = []

  const release = (): void => {
    const next = waiting.shift()
    if (next) {
      // The slot passes straight to the next in line, so `active` stays as it was.
      next()
    } else {
      active -= 1
    }
  }

  return {
    async run(work) {
      if (active < options.concurrency) {
        active += 1
      } else if (waiting.length < options.queue) {
        await new Promise<void>((resolve) => waiting.push(resolve))
      } else {
        throw new Saturated()
      }
      try {
        return await work()
      } finally {
        release()
      }
    },
  }
}

/** The limiters for the work that costs the most per request. */
export type WorkLimits = {
  /** Password hashing and verification (argon2id, 64 MiB each). */
  hash: ConcurrencyLimiter
  /** The breached-password lookup (an outbound HTTP call that waits on a third party). */
  breach: ConcurrencyLimiter
}

/**
 * Builds the limiters from configuration.
 *
 * @param env - The sizes: concurrency and queue for hashing and for the breach lookup.
 */
export function createWorkLimits(env: {
  HASH_CONCURRENCY: number
  HASH_QUEUE: number
  BREACH_CHECK_CONCURRENCY: number
  BREACH_CHECK_QUEUE: number
}): WorkLimits {
  return {
    hash: createConcurrencyLimiter({ concurrency: env.HASH_CONCURRENCY, queue: env.HASH_QUEUE }),
    breach: createConcurrencyLimiter({
      concurrency: env.BREACH_CHECK_CONCURRENCY,
      queue: env.BREACH_CHECK_QUEUE,
    }),
  }
}
