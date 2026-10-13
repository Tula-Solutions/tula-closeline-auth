import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  decodeCursor,
  ERRORS,
  encodeCursor,
  pageQuerySchema,
  pageSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { clientContext, noStore } from '~/http/client'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Bootstrap from '~/modules/bootstrap/service'
import {
  refreshRequestSchema,
  sessionSummarySchema,
  sessionTokensSchema,
} from '~/modules/flow/schema'
import * as Sessions from './refresh'
import * as Auth from './service'

const bearer = z.object({
  authorization: z.string().optional().openapi({ description: 'Bearer <access token>' }),
})
const body = {
  required: true,
  content: { 'application/json': { schema: refreshRequestSchema } },
}

const refresh = createRoute({
  method: 'post',
  path: '/v1/client/sessions/refresh',
  tags: ['sessions'],
  summary: 'Refresh a session',
  description:
    'Trades a refresh token for new tokens. Each refresh token works once; presenting a spent ' +
    'one after a short grace period ends the whole session (`session.reuse_detected`).',
  request: { body },
  responses: {
    200: {
      description: 'New tokens.',
      content: { 'application/json': { schema: sessionTokensSchema } },
    },
    401: errorResponse('The refresh token is invalid, the session ended, or it was reused.'),
    403: errorResponse('The account is banned or has no Organization.'),
    503: errorResponse('The Organization membership service is unavailable.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const signOut = createRoute({
  method: 'post',
  path: '/v1/client/sessions/sign-out',
  tags: ['sessions'],
  summary: 'Sign out',
  description: 'Ends the session of a refresh token. Succeeds for an unknown or spent token too.',
  request: { body },
  responses: {
    204: { description: 'Signed out.' },
    500: errorResponse('Something went wrong on our side.'),
  },
})

const sessionsRoute = createRoute({
  method: 'get',
  path: '/v1/client/sessions',
  tags: ['sessions'],
  summary: 'The user’s sessions',
  description: 'Usable sessions, newest first, a page at a time.',
  request: { headers: bearer, query: pageQuerySchema },
  responses: {
    200: {
      description: 'A page of sessions.',
      content: { 'application/json': { schema: pageSchema(sessionSummarySchema) } },
    },
    401: errorResponse('No valid access token, or its session ended.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/**
 * A cursor's position as the database can use it: a time inside the valid Date range and a uuid,
 * so a forged cursor is refused at the edge instead of failing inside a query.
 */
const position = z.object({ t: z.number().int().min(0).max(8.64e15), i: z.guid() })

/** Refresh, sign-out, the signed-in user and their sessions. */
export function createSessionRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  const tenant = () => Bootstrap.requireTenant(container)

  router.openapi(refresh, async (c) => {
    noStore(c)
    const context = clientContext(container, c)
    const issued = await Sessions.refresh(
      container,
      tenant(),
      c.req.valid('json').refreshToken,
      (userId) => context.report(new Error(`user ${userId} has no Organization`), 403)
    )
    return c.json(issued, 200)
  })

  router.openapi(signOut, async (c) => {
    await Sessions.signOut(container, tenant(), c.req.valid('json').refreshToken)
    return c.body(null, 204)
  })

  router.openapi(sessionsRoute, async (c) => {
    noStore(c)
    const { session } = await Auth.authenticate(container, tenant(), c.req.header('authorization'))
    const query = c.req.valid('query')
    const decoded = query.cursor ? decodeCursor(query.cursor, position) : undefined
    if (query.cursor && !decoded) {
      throw new AppError({
        code: ERRORS['request.invalid'].code,
        status: ERRORS['request.invalid'].status,
        message: ERRORS['request.invalid'].message,
        details: { issues: [{ path: 'cursor', code: 'invalid_value', message: 'Not a cursor.' }] },
      })
    }
    const { sessions, hasMore } = await Sessions.list(
      container,
      tenant(),
      session.userId,
      query.limit,
      decoded ? { createdAt: new Date(decoded.t), id: decoded.i } : undefined
    )
    const last = sessions.at(-1)
    return c.json(
      {
        items: sessions.map((s) => ({
          id: s.id,
          client: s.client,
          createdAt: s.createdAt.toISOString(),
          lastActiveAt: s.lastActiveAt.toISOString(),
          current: s.id === session.id,
        })),
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.getTime(), i: last.id }) : null,
      },
      200
    )
  })

  return router
}
