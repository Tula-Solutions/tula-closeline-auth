/**
 * Removes expired sign-in and rate-limit counters from a shared store, so it does not grow with
 * the number of addresses ever seen. Process-memory counters sweep themselves and have nothing
 * to purge.
 */
export interface CounterPurger {
  /**
   * Deletes up to `limit` counters that expired at least a minute ago, oldest first.
   *
   * @param limit - The batch size; the caller repeats while a batch comes back full.
   * @returns How many were deleted.
   */
  deleteExpired(limit: number): Promise<number>
}
