/**
 * Counts the steps taken by every `Map` iterator (`for...of`, `entries`, `keys`, `values`) while
 * `work` runs, to prove an operation does bounded work however large the map it touches is.
 *
 * @param work - What to run; its result is returned alongside the count.
 */
export async function countMapIterations<T>(
  work: () => Promise<T>
): Promise<{ result: T; steps: number }> {
  const prototype = Object.getPrototypeOf(new Map().entries()) as {
    next: (this: unknown) => unknown
  }
  const original = prototype.next
  let steps = 0
  prototype.next = function (this: unknown) {
    steps += 1
    return original.call(this)
  }
  try {
    return { result: await work(), steps }
  } finally {
    prototype.next = original
  }
}
