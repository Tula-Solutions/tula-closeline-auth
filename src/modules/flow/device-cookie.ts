import { deviceCookieKey, type Env, sessionCookieInsecure } from '~/env'
import { randomToken, timingSafeEqual } from '~/lib/crypto'
import { hmacSha256 } from '~/lib/hmac'
import { readCookie } from '~/modules/session/cookie'

/**
 * Where the known-device cookie is sent: the sign-in routes only (`/v1/client/sign-ins` and
 * everything under it), never the session routes, other services or the rest of this one. No
 * trailing slash, so the route that starts a sign-in carries it too.
 */
export const DEVICE_COOKIE_PATH = '/v1/client/sign-ins'
/** The cookie's name where `Secure` is on (everywhere except a `local` run that opts out). */
export const DEVICE_COOKIE_NAME = '__Secure-tula_known_device'
/** The cookie's name when `SESSION_COOKIE_INSECURE=true` (local over plain http). */
export const DEVICE_COOKIE_NAME_INSECURE = 'tula_known_device'
/** How long a device stays known after its last successful sign-in: 90 days, renewed on each. */
export const DEVICE_COOKIE_TTL_MS = 90 * 24 * 3_600_000

/** The format version, signed into the value so a later format cannot be mistaken for this one. */
const VERSION = 'v1'
const FIELDS = 5
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/
const EXPIRY = /^[0-9]{1,12}$/

/** The account and device a valid cookie vouches for. */
export type KnownDevice = {
  /** The user id (the bare uuid) the device signed in to. */
  userId: string
  /** The random id of the device, the key of its own failure counter. */
  deviceId: string
}

/** The cookie's name in force. */
export function deviceCookieName(env: Env): string {
  return sessionCookieInsecure(env) ? DEVICE_COOKIE_NAME_INSECURE : DEVICE_COOKIE_NAME
}

function sign(env: Env, signed: string): string {
  return hmacSha256(deviceCookieKey(env), `known-device.${signed}`).toString('base64url')
}

/** A new random device id: 16 bytes, 22 URL-safe characters. */
export function newDeviceId(): string {
  return randomToken(16)
}

/**
 * The `Set-Cookie` value that marks a device as known to a user for {@link DEVICE_COOKIE_TTL_MS}.
 * The signed value is `v1.<user id>.<device id>.<expiry in seconds>.<signature>`: the signature
 * covers the other four fields, so the account and the expiry cannot be changed.
 * `HttpOnly; Secure; SameSite=Strict`, host-only, on {@link DEVICE_COOKIE_PATH}.
 */
export function setDeviceCookie(env: Env, device: KnownDevice, now: Date): string {
  const expires = Math.floor((now.getTime() + DEVICE_COOKIE_TTL_MS) / 1000)
  const signed = `${VERSION}.${device.userId}.${device.deviceId}.${expires}`
  return [
    `${deviceCookieName(env)}=${signed}.${sign(env, signed)}`,
    `Path=${DEVICE_COOKIE_PATH}`,
    `Max-Age=${Math.floor(DEVICE_COOKIE_TTL_MS / 1000)}`,
    'HttpOnly',
    ...(sessionCookieInsecure(env) ? [] : ['Secure']),
    'SameSite=Strict',
  ].join('; ')
}

/**
 * The device a request's `Cookie` header vouches for, or `null`. A missing, malformed, tampered,
 * expired or unsigned value all give `null` and nothing else: no error, and the signature is
 * computed and compared in constant time for any value that has the right shape, so the answer
 * does not depend on which check failed. Whether the cookie is for the account being signed in
 * to is the caller's to compare.
 */
export function readDeviceCookie(
  env: Env,
  header: string | undefined,
  now: Date
): KnownDevice | null {
  const value = readCookie(header, deviceCookieName(env))
  const parts = value?.split('.') ?? []
  const [version, userId, deviceId, expires, signature] = parts
  const shaped =
    parts.length === FIELDS &&
    version === VERSION &&
    UUID.test(userId ?? '') &&
    DEVICE_ID.test(deviceId ?? '') &&
    EXPIRY.test(expires ?? '')
  // Always sign something, so a value of the wrong shape costs the same as a forged right one.
  const signed = shaped ? parts.slice(0, 4).join('.') : 'unsigned'
  const matches = timingSafeEqual(sign(env, signed), shaped ? (signature ?? '') : 'x'.repeat(43))
  if (!shaped || !matches || Number(expires) * 1000 <= now.getTime()) {
    return null
  }
  return { userId: userId as string, deviceId: deviceId as string }
}
