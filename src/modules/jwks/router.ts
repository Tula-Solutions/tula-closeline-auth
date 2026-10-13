import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { errorResponses } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Bootstrap from '~/modules/bootstrap/service'
import { jwksSchema } from './schema'
import * as Jwks from './service'

const route = createRoute({
  method: 'get',
  path: '/.well-known/jwks.json',
  tags: ['keys'],
  summary: 'Public signing keys',
  description:
    'The Ed25519 public keys that verify this service’s access tokens: `next`, `active` and ' +
    'recently retired keys, at most 20, public parameters only. A new key is listed at least ' +
    'five minutes before it signs.',
  responses: {
    200: {
      description: 'The key set.',
      content: { 'application/json': { schema: jwksSchema } },
    },
    ...errorResponses(['server.internal']),
  },
})

/** The JWKS route. */
export function createJwksRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.openapi(route, async (c) => {
    const set = await Jwks.publicKeySet(container, Bootstrap.requireTenant(container))
    // An empty set can only be transient; never let a verifier keep it.
    c.header(
      'Cache-Control',
      set.keys.length > 0 ? `public, max-age=${Jwks.JWKS_MAX_AGE_SECONDS}` : 'no-store'
    )
    return c.json(set, 200)
  })
  return router
}
