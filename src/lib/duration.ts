const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** Longest duration accepted anywhere in config: 10 years. */
export const MAX_DURATION_MS = 3650 * UNIT_MS.d

// Positive integer (no leading zero, at most 7 digits) + unit. Zero-length TTLs would issue
// already-expired tokens, and unbounded digit strings overflow to Infinity.
const DURATION_PATTERN = /^([1-9]\d{0,6})(s|m|h|d)$/

/**
 * Convert a duration string such as `60s`, `15m`, `8h` or `30d` to milliseconds.
 *
 * @throws If it is malformed, zero, or longer than {@link MAX_DURATION_MS}.
 */
export function durationToMs(duration: string): number {
  const match = DURATION_PATTERN.exec(duration)
  if (match) {
    const [, amount, unit] = match as unknown as [string, string, keyof typeof UNIT_MS]
    const ms = Number(amount) * UNIT_MS[unit]
    if (ms <= MAX_DURATION_MS) {
      return ms
    }
  }
  throw new Error(`Invalid duration "${duration}"`)
}
