import type { FixedClock } from 'tula-closeline-kit'

/** The statement that moves every stored counter time back by `$1` seconds. */
export const AGE_COUNTERS = `update auth.attempt_counters
  set started_at = started_at - make_interval(secs => $1::float8),
      locked_until = locked_until - make_interval(secs => $1::float8),
      expires_at = expires_at - make_interval(secs => $1::float8)`

/**
 * Lets a test's fixed clock move the Postgres counters. The counters follow the database clock
 * (the memory ones follow the fixed clock), so a test that advances the fixed clock to get past a
 * cooldown or a wait would otherwise still be inside it. Each `advance` is recorded; the returned
 * function, run before a counter call, back-dates the stored times by what was recorded since.
 *
 * @param clock - The fixed clock whose `advance` is observed.
 * @param run - Runs the aging statement with its one parameter (seconds), as the table's owner.
 * @returns The function to await before each counter call.
 */
export function followFixedClock(
  clock: Pick<FixedClock, 'advance' | 'now'>,
  run: (text: string, seconds: number) => Promise<unknown>
): () => Promise<void> {
  let applied = clock.now().getTime()
  // Calls that overlap wait for the same statement, so none counts before the aging is done.
  let inflight: Promise<unknown> = Promise.resolve()
  return async () => {
    const owed = clock.now().getTime() - applied
    if (owed > 0) {
      applied += owed
      inflight = inflight.then(() => run(AGE_COUNTERS, owed / 1000))
    }
    await inflight
  }
}
