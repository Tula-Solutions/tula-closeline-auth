/** Mints the ids of rows, so tests can use a predictable sequence. */
export interface IdGenerator {
  /** A new UUID, time-ordered so inserts stay index-friendly. */
  next(): string
}
