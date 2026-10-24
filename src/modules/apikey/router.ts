import type { OpenAPIHono } from '@hono/zod-openapi'
import { createRoute } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { noStore, sourceOf } from '~/http/client'
import { BODY_ERRORS, errorResponses } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Bootstrap from '~/modules/bootstrap/service'
import { tokenRequestSchema, tokenResponseSchema } from './schema'
import * as ApiKeys from './service'

const exchange = createRoute({
  method: 'post',
  path: '/v1/token',
  tags: ['api-key'],
  summary: 'Exchange an API key for an access token',
  description:
    "Verifies the key with core and returns an access token of 10 minutes for the key's Organization and scopes (no role, no refresh token). Exchange again when it expires. A revoked key stops working at the next exchange. An unknown, malformed, revoked or expired key all answer `apikey.invalid`. Failed attempts are counted per source.",
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: tokenRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The access token.',
      content: { 'application/json': { schema: tokenResponseSchema } },
    },
    ...errorResponses([
      ...BODY_ERRORS,
      'apikey.invalid',
      'apikey.rate_limited',
      'membership.unavailable',
      'server.internal',
    ]),
  },
})

/** `POST /v1/token`: exchange an API key for a short-lived access token. */
export function createApiKeyRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.openapi(exchange, async (c) => {
    noStore(c)
    const { apiKey } = c.req.valid('json')
    const token = await ApiKeys.exchange(container, Bootstrap.requireTenant(container), {
      secret: apiKey,
      source: sourceOf(container, c),
    })
    return c.json(token, 200)
  })
  return router
}
