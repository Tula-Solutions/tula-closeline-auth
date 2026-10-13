import type { Context } from 'hono'
import { type Container, reportSafely } from '~/container'
import type { AppEnv } from '~/http/types'
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
    report: (error, status) =>
      reportSafely(container, error, {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status,
      }),
  }
}
