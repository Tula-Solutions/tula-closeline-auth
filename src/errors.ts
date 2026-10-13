import {
  CORE_ERRORS,
  defineErrors,
  ERRORS,
  type ErrorDefinition,
  SIGNUP_ERRORS,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'

/** The service's own errors, as `area.reason` codes with their HTTP status and default message. */
export const AUTH_ERRORS = {
  ...defineErrors('auth', {
    invalid_credentials: { status: 401, message: 'The email address or password is not right.' },
    user_banned: { status: 403, message: 'This account cannot sign in.' },
  }),
  ...defineErrors('email', {
    invalid: { status: 422, message: 'Enter a valid email address.' },
  }),
  ...defineErrors('password', {
    too_short: { status: 422, message: 'The password is too short.' },
    too_long: { status: 422, message: 'The password is too long.' },
    contains_user_info: { status: 422, message: 'The password contains your name or email.' },
    common: { status: 422, message: 'The password is too common.' },
    breached: {
      status: 422,
      message: 'The password appeared in a data breach. Choose a different one.',
    },
  }),
  ...defineErrors('verification', {
    invalid_code: { status: 422, message: 'The code is not right.' },
    expired: { status: 422, message: 'The code has expired. Ask for a new one.' },
    too_many_attempts: { status: 429, message: 'Too many wrong codes. Ask for a new one.' },
  }),
  ...defineErrors('flow', {
    not_found: { status: 404, message: 'This sign-in or sign-up was not found or has ended.' },
    invalid_step: { status: 409, message: 'This step is not available now. Start again.' },
  }),
  // `auth.no_organization`, `signup.invitation_invalid`, `signup.organization_name_invalid` and
  // `membership.unavailable` come from the contract.
  ...SIGNUP_ERRORS,
  // Core's own code, returned by sign-in and refresh when the user's Organization was deleted.
  'organization.deleted': CORE_ERRORS['organization.deleted'],
  ...defineErrors('mail', {
    unavailable: { status: 503, message: 'The email could not be sent right now. Try again.' },
  }),
  ...defineErrors('session', {
    invalid_token: { status: 401, message: 'The refresh token is not valid.' },
    revoked: { status: 401, message: 'This session has ended.' },
    expired: { status: 401, message: 'This session has expired. Sign in again.' },
    reuse_detected: {
      status: 401,
      message: 'A refresh token was used twice, so the session was ended. Sign in again.',
    },
  }),
} as const

/** Builds the AppError for a registry entry; `details` is returned to the client, so no secrets. */
export function fail(
  definition: ErrorDefinition,
  details?: Record<string, unknown>,
  cause?: unknown
): AppError {
  return new AppError({
    code: definition.code,
    status: definition.status,
    message: definition.message,
    ...(details ? { details } : {}),
    ...(cause === undefined ? {} : { cause }),
  })
}

/** The 429 for a limit that resets after `retryAfterMs`. */
export function rateLimited(definition: ErrorDefinition, retryAfterMs: number): AppError {
  return fail(definition, { retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) })
}

/**
 * The 503 an instance answers with when it is shedding load (a work limiter is full). It is its
 * own class so the error handler can tell it from a real fault: shedding is not reported to the
 * error tracker, or a flood would also flood the tracker.
 */
export class Overloaded extends AppError {
  constructor() {
    super({
      code: ERRORS['server.unavailable'].code,
      status: ERRORS['server.unavailable'].status,
      message: ERRORS['server.unavailable'].message,
      details: { retryAfter: OVERLOAD_RETRY_AFTER_SECONDS },
    })
    this.name = 'Overloaded'
  }
}

/** Seconds a client is told to wait after a shed request. */
export const OVERLOAD_RETRY_AFTER_SECONDS = 1
