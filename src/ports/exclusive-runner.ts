/**
 * Lets work that must not run on two instances at once (a purge, a rotation) take turns,
 * without a leader: whoever finds the name free runs, everyone else skips and tries next time.
 */
export interface ExclusiveRunner {
  /**
   * Runs `work` if no other caller holds `name` right now, and holds `name` until it ends,
   * whether it returns or throws.
   *
   * @param name - What is being guarded, e.g. `retention`.
   * @param work - The exclusive work.
   * @returns `true` when the work ran (and finished), `false` when another caller held the name.
   */
  runExclusive(name: string, work: () => Promise<void>): Promise<boolean>
}
