import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { roleSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { noStore } from '~/http/client'
import { errorResponses } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Bootstrap from '~/modules/bootstrap/service'
import { meSchema } from '~/modules/flow/schema'
import * as Auth from '~/modules/session/service'

const bearer = z.object({
  authorization: z.string().optional().openapi({ description: 'Bearer <access token>' }),
})

const me = createRoute({
  method: 'get',
  path: '/v1/client/me',
  tags: ['sessions'],
  summary: 'The signed-in user',
  description: 'Needs a Bearer access token. A token whose session ended is refused at once.',
  request: { headers: bearer },
  responses: {
    200: { description: 'The user.', content: { 'application/json': { schema: meSchema } } },
    ...errorResponses([
      'auth.unauthenticated',
      'auth.token_expired',
      'auth.token_invalid',
      'auth.unavailable',
      'session.revoked',
      'session.expired',
      'session.reuse_detected',
      'server.internal',
    ]),
  },
})

/** The signed-in user. */
export function createUserRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  const tenant = () => Bootstrap.requireTenant(container)

  router.openapi(me, async (c) => {
    noStore(c)
    const { token, session } = await Auth.authenticate(
      container,
      tenant(),
      c.req.header('authorization')
    )
    const user = await container.users.findById(tenant().environmentId, session.userId)
    if (!user) {
      throw new Error('a live session has no user')
    }
    return c.json(
      {
        id: token.userId,
        email: user.email,
        emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
        firstName: user.firstName,
        lastName: user.lastName,
        bannedAt: user.bannedAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        organization: { id: token.organizationId, role: roleSchema.parse(token.role) },
      },
      200
    )
  })

  return router
}
