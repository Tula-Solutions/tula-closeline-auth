import type { Container } from '~/container'
import { AUTH_ERRORS, fail, rateLimited } from '~/errors'
import { randomDigits, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { durationToMs } from '~/lib/duration'
import { normalizeEmail } from '~/lib/email'
import type { Tenant } from '~/ports/fixed-project'
import type { MailMessage } from '~/ports/mailer'
import type { VerificationSubject } from '~/ports/verification-token-store'
import { codeEmail } from './mail'

/** Digits in an emailed code. */
export const CODE_LENGTH = 6
/** How long a code can be used. */
export const TOKEN_TTL = '10m'
/** Wrong tries a code survives. */
export const MAX_ATTEMPTS = 5
/** The shortest time between two emails to one address. */
export const RESEND_COOLDOWN = '1m'
/** Emails to one address per hour. */
export const SENDS_PER_HOUR = 5
/** Purpose string for the keyed hash that stores codes. */
export const KEYED_HASH_PURPOSE = 'verification-codes'

/** What issuing a code needs from the container. */
export type VerificationDeps = Pick<
  Container,
  'clock' | 'ids' | 'keyedHash' | 'verificationTokens' | 'mailer' | 'rateLimiter'
>

/** How a code reaches its owner; a decoy attempt sends a notice instead of the code. */
export type Delivery = (code: string, ttlMinutes: number, to: string) => MailMessage

function hashInput(tokenId: string, code: string): string {
  return `${tokenId}:${code}`
}

/**
 * Counts one send against the per-address limits (a cooldown and an hourly cap).
 *
 * @throws AppError `verification.too_many_attempts` (429) with `details.retryAfter`.
 */
export async function enforceSendLimits(
  deps: Pick<Container, 'rateLimiter'>,
  tenant: Tenant,
  normalized: string
): Promise<void> {
  const address = `${tenant.environmentId}:${sha256Hex(normalized)}`
  const limits = [
    [`verification_cooldown:${address}`, 1, durationToMs(RESEND_COOLDOWN)],
    [`verification_hourly:${address}`, SENDS_PER_HOUR, durationToMs('1h')],
  ] as const
  for (const [key, limit, windowMs] of limits) {
    const decision = await deps.rateLimiter.hit(key, limit, windowMs)
    if (!decision.allowed) {
      throw rateLimited(AUTH_ERRORS['verification.too_many_attempts'], decision.retryAfterMs)
    }
  }
}

/**
 * Emails a six-digit code for an attempt and stores its keyed hash; a new code replaces any
 * earlier one for the attempt.
 *
 * The email is sent first, then the code stored: if sending fails nothing is stored and the
 * caller sees `mail.unavailable`. Limits per address keep this from being a way to spam it.
 */
export async function issue(
  deps: VerificationDeps,
  tenant: Tenant,
  input: {
    flowAttemptId: string
    destination: string
    message?: Delivery
    /** The caller already counted this send with {@link enforceSendLimits}. */
    limitsEnforced?: boolean
  }
): Promise<void> {
  const destination = normalizeEmail(input.destination)
  if (!input.limitsEnforced) {
    await enforceSendLimits(deps, tenant, destination)
  }

  const code = randomDigits(CODE_LENGTH)
  const ttlMinutes = durationToMs(TOKEN_TTL) / 60_000
  const message = (input.message ?? ((c, t, to) => codeEmail(to, c, t)))(
    code,
    ttlMinutes,
    input.destination.trim()
  )
  try {
    await deps.mailer.send(message)
  } catch (cause) {
    throw fail(AUTH_ERRORS['mail.unavailable'], undefined, cause)
  }

  const now = deps.clock.now()
  const id = deps.ids.next()
  await deps.verificationTokens.replace(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      userId: null,
      flowAttemptId: input.flowAttemptId,
      purpose: 'email_verification',
      destination,
      codeHash: await deps.keyedHash.hmac(KEYED_HASH_PURPOSE, hashInput(id, code)),
      linkTokenHash: null,
      maxAttempts: MAX_ATTEMPTS,
      expiresAt: new Date(now.getTime() + durationToMs(TOKEN_TTL)),
      createdAt: now,
    },
    now
  )
}

/**
 * Checks a submitted code and returns the id of the code's record, without using it up: the
 * caller spends it with {@link consume} once what the code unlocks has succeeded, so a failure
 * in between (a service that is down) does not cost the person their code.
 *
 * Every try is counted before the code is compared, so parallel guesses cannot exceed the limit.
 *
 * @throws AppError `verification.expired`, `verification.too_many_attempts` or
 *   `verification.invalid_code` (with `attemptsRemaining`).
 */
export async function verifyCode(
  deps: Pick<Container, 'clock' | 'keyedHash' | 'verificationTokens'>,
  tenant: Pick<Tenant, 'environmentId'>,
  subject: VerificationSubject,
  code: string
): Promise<string> {
  const now = deps.clock.now()
  const token = await deps.verificationTokens.findLatest(
    tenant.environmentId,
    'email_verification',
    subject
  )
  if (!token || token.consumedAt || token.expiresAt.getTime() <= now.getTime()) {
    throw fail(AUTH_ERRORS['verification.expired'])
  }
  const counted = await deps.verificationTokens.recordAttempt(tenant.environmentId, token.id, now)
  if (!counted) {
    throw fail(AUTH_ERRORS['verification.too_many_attempts'])
  }
  const presented = await deps.keyedHash.hmac(KEYED_HASH_PURPOSE, hashInput(token.id, code))
  if (!timingSafeEqual(presented, counted.codeHash)) {
    throw fail(AUTH_ERRORS['verification.invalid_code'], {
      attemptsRemaining: counted.maxAttempts - counted.attempts,
    })
  }
  return token.id
}

/** Uses up a verified code; a second use of the same code fails with `verification.expired`. */
export async function consume(
  deps: Pick<Container, 'clock' | 'verificationTokens'>,
  tenant: Pick<Tenant, 'environmentId'>,
  tokenId: string
): Promise<void> {
  if (!(await deps.verificationTokens.consume(tenant.environmentId, tokenId, deps.clock.now()))) {
    throw fail(AUTH_ERRORS['verification.expired'])
  }
}
