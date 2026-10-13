/**
 * The password rule engine: evaluates a password against a policy. Ported from the source
 * product's contract package (`password-rules.ts`) with the policy fixed to the `recommended`
 * preset. Only the rules that preset turns on are kept (length, user info, common passwords), so
 * every code a rule can fail with is one of `AUTH_ERRORS` in `tula-closeline-contract`.
 */
import type { AuthErrorCode } from 'tula-closeline-contract'
import { COMMON_PASSWORDS } from './common-passwords'

/** The rules a password is checked against. */
export interface PasswordPolicy {
  minLength: number
  maxLength: number
  disallowUserInfo: boolean
  disallowCommon: boolean
  /** Whether a password found in a breach corpus is refused (`block`), allowed (`off`). */
  breachCheck: 'off' | 'block'
}

/** Rule identifiers shown in the live checklist. */
export type PasswordRule = 'min_length' | 'max_length' | 'user_info' | 'common'

/** The `password.*` codes a rule can fail with; each is a code of the contract's `AUTH_ERRORS`. */
export type PasswordErrorCode = Extract<
  AuthErrorCode,
  'password.too_short' | 'password.too_long' | 'password.contains_user_info' | 'password.common'
>

/** The result of one rule. */
export interface PasswordCheck {
  /** Which rule this is. */
  rule: PasswordRule
  /** The error code to report when the rule fails. */
  code: PasswordErrorCode
  /** Whether the password satisfies the rule. */
  passed: boolean
  /** Rule parameters for rendering, e.g. `{ min: 10 }`. */
  params?: Record<string, string | number | boolean>
}

/** Result of evaluating a password against a policy (breach check excluded; it's async). */
export interface PasswordEvaluation {
  /** True when every rule passed. */
  ok: boolean
  /** Every applicable rule, in checklist order. */
  checks: PasswordCheck[]
}

/** Personal details a password must not contain when `disallowUserInfo` is on. */
export interface PasswordUserInfo {
  email?: string
  firstName?: string
  lastName?: string
  username?: string
}

/**
 * Normalize a password before measuring or hashing it.
 *
 * NFC keeps visually identical Unicode passphrases (e.g. composed vs decomposed "é") equal on
 * every platform.
 *
 * @param password - The raw password.
 * @returns The NFC-normalized password.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFC')
}

const MIN_USER_INFO_LENGTH = 3

function userInfoTokens(info: PasswordUserInfo): string[] {
  const localPart = info.email?.split('@')[0]
  return [localPart, info.firstName, info.lastName, info.username]
    .map((value) => (value ? normalizePassword(value).trim().toLowerCase() : undefined))
    .filter((value): value is string => !!value && value.length >= MIN_USER_INFO_LENGTH)
}

/**
 * Evaluate a password against a policy and return every rule's result.
 *
 * Pure and synchronous so it runs identically on the server and inside SDKs (live checklist).
 * Length is measured in Unicode code points after NFC normalization, so emoji and accented
 * passphrases count the way users expect. The breached-password check is not included; the server
 * runs it separately.
 *
 * @param policy - The active password policy.
 * @param password - The candidate password.
 * @param userInfo - Personal details the password must not contain.
 * @returns `ok` plus the result of each applicable rule.
 *
 * @example
 * ```ts
 * const { ok, checks } = evaluatePassword(PASSWORD_POLICY, 'correct horse')
 * ```
 */
export function evaluatePassword(
  policy: PasswordPolicy,
  password: string,
  userInfo: PasswordUserInfo = {}
): PasswordEvaluation {
  const chars = [...normalizePassword(password)]
  const checks: PasswordCheck[] = []

  checks.push({
    rule: 'min_length',
    code: 'password.too_short',
    passed: chars.length >= policy.minLength,
    params: { min: policy.minLength },
  })
  checks.push({
    rule: 'max_length',
    code: 'password.too_long',
    passed: chars.length <= policy.maxLength,
    params: { max: policy.maxLength },
  })
  if (policy.disallowUserInfo) {
    const lower = chars.join('').toLowerCase()
    checks.push({
      rule: 'user_info',
      code: 'password.contains_user_info',
      passed: !userInfoTokens(userInfo).some((token) => lower.includes(token)),
    })
  }
  if (policy.disallowCommon) {
    checks.push({
      rule: 'common',
      code: 'password.common',
      passed: !COMMON_PASSWORDS.has(chars.join('').toLowerCase()),
    })
  }

  return { ok: checks.every((check) => check.passed), checks }
}

/** The one policy this service applies: NIST 800-63B style, length and breach check only. */
export const PASSWORD_POLICY: PasswordPolicy = {
  minLength: 10,
  maxLength: 128,
  disallowUserInfo: true,
  disallowCommon: true,
  breachCheck: 'block',
}
