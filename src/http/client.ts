import type { Context } from 'hono'
import { type Container, reportSafely } from '~/container'
import type { AppEnv } from '~/http/types'
import { CLIENT_HEADER, clientSchema } from '~/modules/flow/schema'
import type { ClientContext } from '~/modules/flow/service'

/** Tokens and secrets must never be stored by a cache or an intermediary. */
export function noStore(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store')
}

/** What a flow needs to know about the request: the kind of client, and how to report a fault. */
export function clientContext(container: Container, c: Context<AppEnv>): ClientContext {
  const parsed = clientSchema.safeParse(c.req.header(CLIENT_HEADER))
  return {
    client: parsed.success ? parsed.data : 'web',
    report: (error, status) =>
      reportSafely(container, error, {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status,
      }),
  }
}
