import type { CounterPurger } from '~/ports/counter-purger'

/** The purger for process-memory counters, which sweep themselves: it deletes nothing. */
export function createMemoryCounterPurger(): CounterPurger {
  return {
    async deleteExpired() {
      return 0
    },
  }
}
