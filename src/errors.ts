import {
  AUTH_ERRORS,
  type AuthErrorCode,
  type CommonErrorCode,
  ERRORS,
  type ErrorDefinition,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'

/**
 * A code this service may answer with: one of `AUTH_ERRORS` or the common `ERRORS`, both defined
 * in `tula-closeline-contract`. This service defines no code of its own.
 */
export type ServiceErrorCode = AuthErrorCode | CommonErrorCode

/** Every definition this service may answer with, by code: the contract's, never a local one. */
export const DEFINITIONS: Readonly<Record<ServiceErrorCode, ErrorDefinition<ServiceErrorCode>>> = {
  ...ERRORS,
  ...AUTH_ERRORS,
}

/**
 * Builds the AppError for a registry entry; `details` is returned to the client, so no secrets.
 * Only the code of `definition` is read: the status and message come from the contract's own
 * entry for that code, so a definition written by hand cannot change what a code means.
 */
export function fail(
  definition: ErrorDefinition<ServiceErrorCode>,
  details?: Record<string, unknown>,
  cause?: unknown
): AppError {
  const { code, status, message } = DEFINITIONS[definition.code]
  return new AppError({
    code,
    status,
    message,
    ...(details ? { details } : {}),
    ...(cause === undefined ? {} : { cause }),
  })
}

/** The 429 for a limit that resets after `retryAfterMs`. */
export function rateLimited(
  definition: ErrorDefinition<ServiceErrorCode>,
  retryAfterMs: number
): AppError {
  return fail(definition, { retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) })
}

/**
 * An error the error handler does not report to the tracker on its own, because it is either
 * expected under load (shedding, an outage of core) or reported by the code that raised it, once,
 * with the context that code has.
 */
export class Unreported extends AppError {}

/**
 * The 503 an instance answers with when it is shedding load (a work limiter is full). It is its
 * own class so the error handler can tell it from a real fault: shedding is not reported to the
 * error tracker, or a flood would also flood the tracker.
 */
export class Overloaded extends Unreported {
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

/** Seconds a client is told to wait (`Retry-After`) when core could not answer. */
export const MEMBERSHIP_RETRY_AFTER_SECONDS = 5

/**
 * The 503 `membership.unavailable` (with `Retry-After`) for a call to core that did not answer
 * in time or failed. Nothing was issued, counted or rotated, so the client retries the same
 * request. The error handler logs every one at warn with {@link MembershipOutage.causeClass} and
 * reports only a deployment fault ({@link MembershipOutage.deploymentFault}, a rejected shared
 * secret), at most once a minute per cause class: an outage hits every request, and a report each
 * would drown the tracker in one fault.
 */
export class MembershipOutage extends Unreported {
  /** The class name of what went wrong; a fixed word, never a message, so it is safe to log. */
  readonly causeClass: string
  /** Whether this will not clear by itself and the deployment must fix it. */
  readonly deploymentFault: boolean

  constructor(cause: unknown, deploymentFault: boolean) {
    super({
      code: AUTH_ERRORS['membership.unavailable'].code,
      status: AUTH_ERRORS['membership.unavailable'].status,
      message: AUTH_ERRORS['membership.unavailable'].message,
      details: { retryAfter: MEMBERSHIP_RETRY_AFTER_SECONDS },
      cause,
    })
    this.name = 'MembershipOutage'
    this.causeClass = cause instanceof Error ? cause.name : 'unknown'
    this.deploymentFault = deploymentFault
  }
}

/**
 * The 500 for a fault in core that retrying cannot clear (it says a brand new user is already a
 * member). The sign-up flow reports it once per attempt, with ids, before throwing it, so the
 * error handler does not report it again; the client sees the common internal error, with no
 * `Retry-After`.
 */
export class MembershipFaulted extends Unreported {
  constructor(cause: unknown) {
    super({
      code: ERRORS['server.internal'].code,
      status: ERRORS['server.internal'].status,
      message: ERRORS['server.internal'].message,
      cause,
    })
    this.name = 'MembershipFaulted'
  }
}
