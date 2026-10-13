import { ERRORS } from 'tula-closeline-contract'
import { allowedOrigins, type Env, sessionCookieInsecure } from '~/env'
import { fail } from '~/errors'
import type { IssuedSession } from './service'

/**
 * Where the refresh cookie is sent: the narrowest common prefix of the two routes that read it
 * (`/v1/client/sessions/refresh` and `/sign-out`). The trailing slash keeps it off
 * `GET /v1/client/sessions` and off every other service behind the same origin.
 */
export const REFRESH_COOKIE_PATH = '/v1/client/sessions/'
/** The cookie's name where `Secure` is on (everywhere except a `local` run that opts out). */
export const REFRESH_COOKIE_NAME = '__Secure-tula_refresh'
/** The cookie's name when `SESSION_COOKIE_INSECURE=true` (local over plain http). */
export const REFRESH_COOKIE_NAME_INSECURE = 'tula_refresh'

/** The cookie's name in force. */
export function refreshCookieName(env: Env): string {
  return sessionCookieInsecure(env) ? REFRESH_COOKIE_NAME_INSECURE : REFRESH_COOKIE_NAME
}

function attributes(env: Env, maxAgeSeconds: number): string {
  return [
    `Path=${REFRESH_COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    ...(sessionCookieInsecure(env) ? [] : ['Secure']),
    'SameSite=Strict',
  ].join('; ')
}

/** The `Set-Cookie` value that carries a refresh token for the session's remaining lifetime. */
export function setRefreshCookie(env: Env, session: IssuedSession, now: Date): string {
  const seconds = Math.max(
    0,
    Math.floor((session.absoluteExpiresAt.getTime() - now.getTime()) / 1000)
  )
  return `${refreshCookieName(env)}=${session.refreshToken}; ${attributes(env, seconds)}`
}

/** The `Set-Cookie` value that clears the refresh cookie (same name, path and attributes). */
export function clearRefreshCookie(env: Env): string {
  return `${refreshCookieName(env)}=; ${attributes(env, 0)}`
}

/**
 * The value of the cookie `name` in a request's `Cookie` header, or `undefined` when it is absent
 * or empty. Other cookies are ignored.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined
  }
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) {
      const value = part.slice(at + 1).trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/** The refresh token in a request's `Cookie` header, or `undefined`. Other cookies are ignored. */
export function readRefreshCookie(env: Env, header: string | undefined): string | undefined {
  return readCookie(header, refreshCookieName(env))
}

/**
 * Refuses a cookie-authenticated request that did not come from an allowed origin: `Origin` must
 * be present and exactly one of `SESSION_ALLOWED_ORIGINS`, and `Sec-Fetch-Site`, when present,
 * must be `same-origin`. Runs before the token is read and touches no session.
 *
 * @throws AppError `auth.forbidden`.
 */
export function requireAllowedOrigin(
  env: Env,
  headers: { origin: string | undefined; fetchSite: string | undefined }
): void {
  const { origin, fetchSite } = headers
  if (
    origin === undefined ||
    !allowedOrigins(env).includes(origin) ||
    (fetchSite !== undefined && fetchSite !== 'same-origin')
  ) {
    throw fail(ERRORS['auth.forbidden'])
  }
}

/**
 * The refresh failures after which the token can never work again (the session is over, or the
 * token is unknown): the browser's cookie is cleared with them. Anything else (core unavailable,
 * rate limiting, a 5xx, `auth.no_organization` which an operator may repair) leaves the token
 * unspent, so the cookie stays and the client retries.
 */
export const TERMINAL_REFRESH_CODES: ReadonlySet<string> = new Set([
  'session.invalid_token',
  'session.revoked',
  'session.expired',
  'session.reuse_detected',
  'auth.user_banned',
  'organization.deleted',
])
