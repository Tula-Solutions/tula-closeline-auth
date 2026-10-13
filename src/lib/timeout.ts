/**
 * Races a promise against a deadline.
 *
 * The work is not cancelled (a promise cannot be); the caller stops waiting and `onTimeout`
 * supplies the error to throw. Use it around calls to other services, which must never be waited
 * on without a bound.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}
