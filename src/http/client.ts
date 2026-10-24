import type { Context } from 'hono'
import { type Container, reportSafely } from '~/container'
import { trustedProxyHops } from '~/env'
import type { AppEnv } from '~/http/types'
import { readDeviceCookie } from '~/modules/flow/device-cookie'
import { CLIENT_HEADER, clientHeaderSchema } from '~/modules/flow/schema'
import type { ClientContext } from '~/modules/flow/service'

/** Tokens and secrets must never be stored by a cache or an intermediary. */
export function noStore(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store')
}

/** Whether the request names the `browser` client type (the refresh-cookie flow). */
export function isBrowserClient(c: Context<AppEnv>): boolean {
  return c.req.header(CLIENT_HEADER) === 'browser'
}

/** What a flow needs to know about the request: the kind of client, and how to report a fault. */
export function clientContext(container: Container, c: Context<AppEnv>): ClientContext {
  const parsed = clientHeaderSchema.safeParse(c.req.header(CLIENT_HEADER))
  const header = parsed.success ? parsed.data : 'web'
  return {
    // A browser session is recorded as `web`; `browser` only selects the cookie transport.
    client: header === 'browser' ? 'web' : header,
    cookie: header === 'browser',
    knownDevice: () =>
      readDeviceCookie(container.env, c.req.header('cookie'), container.clock.now()),
    report: (error, status) =>
      reportSafely(container, error, {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status,
      }),
  }
}

/**
 * A request's source for the rate limits: the hop `TRUSTED_PROXY_HOPS` from the right of
 * `X-Forwarded-For`, which the proxies in front of this service wrote. Anything further left was
 * written by the client and is ignored. A header with fewer hops, or none, is the one shared
 * `unknown` bucket: nothing the client supplied is trusted.
 */
export function sourceOf(container: Container, c: Context<AppEnv>): string {
  const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim())
  const depth = trustedProxyHops(container.env)
  const client = hops.length >= depth ? hops[hops.length - depth] : undefined
  return client === undefined || client === '' ? 'unknown' : client.slice(0, 64)
}
