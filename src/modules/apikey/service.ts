import { APIKEY_ERRORS } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { fail, MembershipOutage, rateLimited } from '~/errors'
import { withTimeout } from '~/lib/timeout'
import { MEMBERSHIP_TIMEOUT_MS } from '~/modules/membership/service'
import * as Tokens from '~/modules/token/service'
import type { Tenant } from '~/ports/fixed-project'
import type { LockoutPolicy } from '~/ports/lockout'
import { ApiKeyRateLimited, ApiKeyRefused, MembershipRejected } from '~/ports/membership'

/**
 * Failed exchanges per source (ADR 0023), counted in Postgres through the lockout port. More
 * free tries than a password (many programs share one address behind a NAT), then 30s doubling
 * to 15 minutes, forgotten after an hour of quiet.
 */
export const API_KEY_SOURCE_LOCKOUT: LockoutPolicy = {
  freeAttempts: 20,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
  forgetAfterMs: 60 * 60_000,
}

/** What the exchange needs from the container. */
export type ExchangeDeps = Pick<
  Container,
  'env' | 'clock' | 'signingKeys' | 'secretBox' | 'ids' | 'membership' | 'lockout' | 'logger'
>

/** The seconds a caller is told to wait when core's 429 named no pause. */
const DEFAULT_RETRY_AFTER_MS = 1_000

/**
 * Exchanges an API key for a 10 minute access token (ADR 0023): asks core to verify the secret,
 * then signs a token that carries the key's Organization and scopes and no role.
 *
 * Every attempt from a source is counted up front, in Postgres, and a success forgets the
 * count, so only a source that keeps failing is slowed. An unknown, malformed, revoked or expired
 * key is one `apikey.invalid`: nothing tells which keys exist. Core's 429 passes through with its
 * pause. Nothing is minted while core cannot answer (`membership.unavailable`, 503).
 *
 * @param deps - The container.
 * @param tenant - The fixed project that owns the signing keys.
 * @param input - The key's secret (never logged or put in an error) and the request's source.
 * @throws AppError `apikey.invalid`, `apikey.rate_limited` or `membership.unavailable`.
 */
export async function exchange(
  deps: ExchangeDeps,
  tenant: Tenant,
  input: { secret: string; source: string }
): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  // Loaded before anything is counted or asked of core: a failure here has no side effect.
  const sign = await Tokens.apiKeySigner(deps, tenant)
  const lockKey = `api_key_exchange:src:${input.source}`
  const now = deps.clock.now()
  const decision = await deps.lockout.attempt(lockKey, API_KEY_SOURCE_LOCKOUT, now)
  if (!decision.allowed) {
    throw rateLimited(APIKEY_ERRORS['apikey.rate_limited'], decision.retryAfterMs)
  }
  const controller = new AbortController()
  let verified: Awaited<ReturnType<typeof deps.membership.verifyApiKey>>
  try {
    verified = await withTimeout(
      deps.membership.verifyApiKey(input.secret, controller.signal),
      MEMBERSHIP_TIMEOUT_MS,
      () => {
        controller.abort()
        return new Error('api key verification timed out')
      }
    )
  } catch (error) {
    if (error instanceof ApiKeyRefused) {
      // Revoked and unknown are the same answer; the count stays.
      throw fail(APIKEY_ERRORS['apikey.invalid'])
    }
    if (error instanceof ApiKeyRateLimited) {
      throw rateLimited(
        APIKEY_ERRORS['apikey.rate_limited'],
        error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS
      )
    }
    // Core being down is not the caller's failure: do not let an outage lock a source out.
    await deps.lockout.clear(lockKey)
    throw new MembershipOutage(error, error instanceof MembershipRejected)
  }
  const issuedAt = deps.clock.now()
  if (verified.expiresAt !== null && new Date(verified.expiresAt) <= issuedAt) {
    // Core normally refuses an expired key; the same answer here if its clock ran behind ours.
    throw fail(APIKEY_ERRORS['apikey.invalid'])
  }
  const token = await sign(verified, issuedAt)
  await deps.lockout.clear(lockKey)
  return token
}
