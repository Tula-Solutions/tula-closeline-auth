import { OIDC_COOKIE_BASE_NAME, OIDC_COOKIE_SECURE_PREFIX } from 'tula-closeline-contract'
import type { Env } from '~/env'

/**
 * Where the attempt cookie is sent: the three Sign in with Google routes and nothing else. The
 * trailing slash keeps it off every other route and every other service behind the same origin.
 */
export const OIDC_COOKIE_PATH = '/v1/client/google/'
/** How long the attempt cookie lives, in seconds: the attempt's own lifetime. */
export const OIDC_COOKIE_MAX_AGE_SECONDS = 600

/** Whether the cookie carries `Secure` and the `__Secure-` prefix: everywhere but `local`. */
function secure(env: Env): boolean {
  return env.ENVIRONMENT !== 'local'
}

/** The cookie's name: `__Secure-tula_oidc`, or `tula_oidc` in `local` (Safari refuses the prefix on http). */
export function oidcCookieName(env: Env): string {
  return secure(env)
    ? `${OIDC_COOKIE_SECURE_PREFIX}${OIDC_COOKIE_BASE_NAME}`
    : OIDC_COOKIE_BASE_NAME
}

function attributes(env: Env, maxAgeSeconds: number): string {
  return [
    `Path=${OIDC_COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    ...(secure(env) ? ['Secure'] : []),
    // Lax, not Strict: Google's redirect back is a cross-site top-level navigation.
    'SameSite=Lax',
  ].join('; ')
}

/** The `Set-Cookie` value that carries the attempt secret for the attempt's lifetime. */
export function setOidcCookie(env: Env, secret: string): string {
  return `${oidcCookieName(env)}=${secret}; ${attributes(env, OIDC_COOKIE_MAX_AGE_SECONDS)}`
}

/** The `Set-Cookie` value that clears the attempt cookie (same name, path and attributes). */
export function clearOidcCookie(env: Env): string {
  return `${oidcCookieName(env)}=; ${attributes(env, 0)}`
}
