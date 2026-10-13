import type { Container } from '~/container'
import { AUTH_ERRORS, fail, Overloaded } from '~/errors'
import { type ConcurrencyLimiter, Saturated } from '~/lib/concurrency'
import {
  evaluatePassword,
  normalizePassword,
  PASSWORD_POLICY,
  type PasswordCheck,
  type PasswordUserInfo,
} from './rules'

/** The source's argon2id parameters; any hash with other parameters is rehashed after sign-in. */
export const HASH_OPTIONS = { algorithm: 'argon2id', memoryCost: 65_536, timeCost: 2 } as const

/** Longest password accepted, in code points; bounds the work a hash can be made to do. */
export const MAX_PASSWORD_LENGTH = 1024

/**
 * A hash of a throwaway password, verified against when an address has no account or no
 * password, so that an unknown address costs the same time as a known one.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$6UPSxbALfg+qiYLsSJZVCEirNUMx02RS54WyXH3jMfE$fX52GP8UlKtUYDMHRDIdBmrmEps+/rCKGNM6H2fZQow'

const CURRENT_PREFIX = `$argon2id$v=19$m=${HASH_OPTIONS.memoryCost},t=${HASH_OPTIONS.timeCost},p=1$`

/** A raw password longer than this is refused before it is normalized (NFC can shrink, not grow much). */
const MAX_RAW_LENGTH = MAX_PASSWORD_LENGTH * 16

/** The `password.*` codes the fixed policy can fail with, mapped to the registry. */
const POLICY_ERRORS = {
  'password.too_short': AUTH_ERRORS['password.too_short'],
  'password.too_long': AUTH_ERRORS['password.too_long'],
  'password.contains_user_info': AUTH_ERRORS['password.contains_user_info'],
  'password.common': AUTH_ERRORS['password.common'],
} as const

/** What password work needs from the container: the limiters that bound it. */
export type PasswordDeps = Pick<Container, 'limits'>

/** The lane a unit of password work runs in: sign-up hashing or sign-in verification. */
export type Lane = 'hash' | 'signIn'

/**
 * Runs `work` in a lane's limiter; a full limiter is a 503 the client retries, not a fault.
 *
 * The caller does everything that counts against a person (a send, a failed try) inside `work`,
 * so a request that is shed was never counted.
 */
export async function inLane<T>(
  deps: PasswordDeps,
  lane: Lane,
  work: () => Promise<T>
): Promise<T> {
  return limited(deps.limits[lane], work)
}

async function limited<T>(limiter: ConcurrencyLimiter, work: () => Promise<T>): Promise<T> {
  try {
    return await limiter.run(work)
  } catch (error) {
    throw error instanceof Saturated ? new Overloaded() : error
  }
}

function normalizeCapped(password: string): string | null {
  if (password.length > MAX_RAW_LENGTH) {
    return null
  }
  const normalized = normalizePassword(password)
  return [...normalized].length > MAX_PASSWORD_LENGTH ? null : normalized
}

/**
 * Whether a submitted password is short enough for any stored password to match. A longer one
 * can be refused before anything is counted or hashed: no account can have it.
 */
export function withinLimit(password: string): boolean {
  return normalizeCapped(password) !== null
}

/**
 * Hashes a password with argon2id after NFC normalization. The caller holds a slot of the lane it
 * runs in ({@link inLane}); this does not take one.
 *
 * @throws AppError `password.too_long`.
 */
export async function hashHeld(password: string): Promise<string> {
  const normalized = normalizeCapped(password)
  if (normalized === null) {
    throw fail(AUTH_ERRORS['password.too_long'], { max: MAX_PASSWORD_LENGTH })
  }
  return Bun.password.hash(normalized, HASH_OPTIONS)
}

/**
 * Checks a password against a stored hash. With no hash it still pays for one verification (a
 * dummy hash) and answers `false`, so an unknown account takes as long as a known one. The caller
 * holds a slot of the sign-in lane ({@link inLane}); this does not take one.
 */
export async function verifyHeld(storedHash: string | null, password: string): Promise<boolean> {
  const normalized = normalizeCapped(password)
  // No stored password can be this long, so rejecting early leaks nothing about the account.
  if (normalized === null) {
    return false
  }
  const matches = await Bun.password.verify(normalized, storedHash ?? DUMMY_HASH)
  return storedHash !== null && matches
}

/** Whether a stored hash was made with weaker parameters than today's. */
export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith(CURRENT_PREFIX)
}

function fieldError(check: PasswordCheck) {
  return { field: 'password', code: check.code, ...(check.params ? { params: check.params } : {}) }
}

/**
 * Refuses a password that breaks the policy. Cheap and local: no lookup, no hash.
 *
 * @returns The NFC-normalized password, for the steps that follow.
 * @throws AppError `password.*` (422) with every failed rule in `details.errors`.
 */
export function checkPolicy(password: string, userInfo: PasswordUserInfo = {}): string {
  const normalized = normalizePassword(password)
  const failed = evaluatePassword(PASSWORD_POLICY, normalized, userInfo).checks.filter(
    (check) => !check.passed
  )
  const [first] = failed
  if (first) {
    const definition = POLICY_ERRORS[first.code as keyof typeof POLICY_ERRORS]
    throw fail(definition ?? AUTH_ERRORS['password.too_short'], {
      ...(first.params ?? {}),
      errors: failed.map(fieldError),
    })
  }
  return normalized
}

/**
 * Refuses a password that appears in a known breach, inside the breach limiter. A lookup that
 * cannot be made lets the password through.
 *
 * @param admitted - Runs once the request holds a lookup slot and before the lookup, so what it
 *   counts (a send against an address) is never charged to a request that was shed.
 * @throws AppError `password.breached` (422), or `server.unavailable` (503) when the limiter is
 *   full.
 */
export async function checkBreach(
  deps: Pick<Container, 'breachChecker' | 'limits'>,
  normalized: string,
  admitted?: () => Promise<void>
): Promise<void> {
  await limited(deps.limits.breach, async () => {
    await admitted?.()
    if (
      PASSWORD_POLICY.breachCheck === 'block' &&
      (await deps.breachChecker.check(normalized)) === 'breached'
    ) {
      throw fail(AUTH_ERRORS['password.breached'], {
        errors: [{ field: 'password', code: 'password.breached' }],
      })
    }
  })
}

/**
 * Refuses a password that breaks the policy or appears in a known breach.
 *
 * @throws AppError `password.*` (422) with every failed rule in `details.errors`.
 */
export async function assess(
  deps: Pick<Container, 'breachChecker' | 'limits'>,
  password: string,
  userInfo: PasswordUserInfo = {}
): Promise<void> {
  await checkBreach(deps, checkPolicy(password, userInfo))
}
