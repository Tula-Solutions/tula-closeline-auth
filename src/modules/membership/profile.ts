import { personNameSchema } from 'tula-closeline-contract'

/** A control character as the contract's person name refuses it: C0, DEL and C1. */
const CONTROL_RUN = /\p{Cc}+/gu

/**
 * The name auth sends to core for the member list: the optional first and last names joined by
 * one space, or `null` when there is nothing to show.
 *
 * Auth stores each part up to 100 characters and allows control characters inside them, which the
 * contract's `personNameSchema` refuses; two parts of 100 and the space are 201, exactly the
 * contract's maximum. So each run of control characters becomes one space (the stored names are
 * untouched), the result is trimmed, and the answer is checked against the contract once more:
 * a name that would still fail is sent as `null`, so a sign-up never fails at core over a name.
 */
export function composeMemberName(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): string | null {
  const joined = [firstName, lastName]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ')
    .replace(CONTROL_RUN, ' ')
  const parsed = personNameSchema.safeParse(joined)
  return parsed.success ? parsed.data : null
}
