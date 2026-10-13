import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  AUTH_ERRORS,
  decodeCursor,
  ERRORS,
  encodeCursor,
  pageQuerySchema,
  pageSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { fail } from '~/errors'
import { clientContext, isBrowserClient, noStore } from '~/http/client'
import { BODY_ERRORS, errorResponses } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Bootstrap from '~/modules/bootstrap/service'
import {
  browserSessionTokensSchema,
  refreshRequestSchema,
  sessionSummarySchema,
  sessionTokensSchema,
} from '~/modules/flow/schema'
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  readRefreshCookie,
  requireAllowedOrigin,
  setRefreshCookie,
  TERMINAL_REFRESH_CODES,
} from './cookie'
import * as Sessions from './refresh'
import * as Auth from './service'

const bearer = z.object({
  authorization: z.string().optional().openapi({ description: 'Bearer <access token>' }),
})
/** What a bearer access token can be refused with: the token itself, or its session's end. */
const BEARER_ERRORS = [
  'auth.unauthenticated',
  'auth.token_expired',
  'auth.token_invalid',
  'auth.unavailable',
  'session.revoked',
  'session.expired',
  'session.reuse_detected',
  'server.internal',
] as const

/** Headers and the cookie a `browser` client uses; strings, so documenting them validates nothing. */
const cookieClientHeaders = z.object({
  'x-tula-client': z
    .string()
    .optional()
    .openapi({
      description:
        'Client type. `browser` reads the refresh token from the cookie only, ignores the body, ' +
        'and requires `Origin`; every other value reads it from the body.',
    }),
  origin: z.string().optional().openapi({
    description:
      'Client type `browser`: required, and exactly one of `SESSION_ALLOWED_ORIGINS`, else `auth.forbidden`.',
  }),
  'sec-fetch-site': z.string().optional().openapi({
    description: 'Client type `browser`: when present it must be `same-origin`.',
  }),
})
const refreshCookie = z.object({
  [REFRESH_COOKIE_NAME]: z
    .string()
    .optional()
    .openapi({
      description:
        'Client type `browser`: the refresh token, set by the sign-in, sign-up and refresh ' +
        'responses (`tula_refresh`, unprefixed and without `Secure`, when ' +
        '`SESSION_COOKIE_INSECURE=true` in local development).',
    }),
})
const setCookieHeader = z.object({
  'set-cookie': z
    .string()
    .optional()
    .openapi({
      description:
        'Client type `browser`: `__Secure-tula_refresh=<token>; Path=/v1/client/sessions/; ' +
        'Max-Age=<remaining absolute lifetime>; HttpOnly; Secure; SameSite=Strict`, no `Domain`. ' +
        'Sign-out sends the same name, path and attributes with an empty value and `Max-Age=0`.',
    }),
})

const body = {
  required: true,
  content: { 'application/json': { schema: refreshRequestSchema } },
}

/**
 * Marks the responses that can carry the clearing `Set-Cookie` (client type `browser`, a refresh
 * that can never work again: 401 session codes, 403 `auth.user_banned`, 410 `organization.deleted`).
 */
function withClearedCookie<T extends Record<string, object>>(responses: T): T {
  return Object.fromEntries(
    Object.entries(responses).map(([status, response]) => [
      status,
      ['401', '403', '410'].includes(status)
        ? {
            ...response,
            headers: z.object({
              'set-cookie': z
                .string()
                .optional()
                .openapi({
                  description:
                    'Client type `browser`, when the code means the token can never work again ' +
                    '(`session.*`, `auth.user_banned`, `organization.deleted`): the cookie cleared ' +
                    '(`Max-Age=0`). Never on `auth.forbidden` or `membership.unavailable`.',
                }),
            }),
          }
        : response,
    ])
  ) as T
}

const refresh = createRoute({
  method: 'post',
  path: '/v1/client/sessions/refresh',
  tags: ['sessions'],
  summary: 'Refresh a session',
  description:
    'Trades a refresh token for new tokens. Each refresh token works once; presenting a spent ' +
    'one after a short grace period ends the whole session (`session.reuse_detected`). If the ' +
    'core service cannot answer, the answer is 503 `membership.unavailable` with `Retry-After` ' +
    'and the refresh token is not spent: send the same one again. A user whose Organization ' +
    'was deleted gets `organization.deleted` and the session ends. Client type `browser` ' +
    '(`x-tula-client: browser`) sends no body: the refresh token is read from the cookie only ' +
    '(a body or header token is ignored, a missing cookie is `session.invalid_token`), `Origin` ' +
    'is checked first (`auth.forbidden`), and the new refresh token is set in the cookie and ' +
    'omitted from the body.',
  request: { headers: cookieClientHeaders, cookies: refreshCookie, body },
  responses: {
    200: {
      description:
        'New tokens, in one of two shapes by client type: `SessionTokens` (every type but ' +
        '`browser`, refresh token in the body) or `BrowserSessionTokens` (`browser`, refresh ' +
        'token in the `Set-Cookie` header).',
      headers: setCookieHeader,
      content: {
        'application/json': {
          schema: z.xor([sessionTokensSchema, browserSessionTokensSchema]),
        },
      },
    },
    ...withClearedCookie(
      errorResponses([
        ...BODY_ERRORS,
        'auth.forbidden',
        'session.invalid_token',
        'session.revoked',
        'session.expired',
        'session.reuse_detected',
        'auth.user_banned',
        'auth.no_organization',
        'organization.deleted',
        'membership.unavailable',
        'server.internal',
      ])
    ),
  },
})

const signOut = createRoute({
  method: 'post',
  path: '/v1/client/sessions/sign-out',
  tags: ['sessions'],
  summary: 'Sign out',
  description:
    'Ends the session of a refresh token. Succeeds for an unknown or spent token too. Client ' +
    'type `browser` sends no body: the token is read from the cookie only, `Origin` is checked ' +
    'first (`auth.forbidden`), and the cookie is cleared whether or not a session was found.',
  request: { headers: cookieClientHeaders, cookies: refreshCookie, body },
  responses: {
    204: { description: 'Signed out.', headers: setCookieHeader },
    ...errorResponses([...BODY_ERRORS, 'auth.forbidden', 'server.internal']),
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
    ...errorResponses(['request.invalid', ...BEARER_ERRORS]),
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
  const onNoOrganization = (c: Context<AppEnv>) => (userId: string) =>
    clientContext(container, c).report(new Error(`user ${userId} has no Organization`), 403)

  /**
   * The cookie flow of the `browser` client type, in front of the body flow below (which every
   * other client type still gets untouched). Origin first, then the cookie, never the body.
   */
  const cookieFlow = (run: (c: Context<AppEnv>, token: string | undefined) => Promise<Response>) =>
    createMiddleware<AppEnv>(async (c, next) => {
      if (!isBrowserClient(c)) {
        return next()
      }
      noStore(c)
      requireAllowedOrigin(container.env, {
        origin: c.req.header('origin'),
        fetchSite: c.req.header('sec-fetch-site'),
      })
      return run(c, readRefreshCookie(container.env, c.req.header('cookie')))
    })

  router.post(
    refresh.path,
    cookieFlow(async (c, token) => {
      try {
        if (token === undefined) {
          throw fail(AUTH_ERRORS['session.invalid_token'])
        }
        const issued = await Sessions.refresh(container, tenant(), token, onNoOrganization(c))
        c.header('Set-Cookie', setRefreshCookie(container.env, issued, container.clock.now()))
        return c.json(Auth.browserBodyOf(issued), 200)
      } catch (error) {
        if (error instanceof AppError && TERMINAL_REFRESH_CODES.has(error.code)) {
          c.header('Set-Cookie', clearRefreshCookie(container.env))
        }
        throw error
      }
    })
  )
  router.post(
    signOut.path,
    cookieFlow(async (c, token) => {
      if (token !== undefined) {
        await Sessions.signOut(container, tenant(), token)
      }
      c.header('Set-Cookie', clearRefreshCookie(container.env))
      return c.body(null, 204)
    })
  )

  router.openapi(refresh, async (c) => {
    noStore(c)
    const issued = await Sessions.refresh(
      container,
      tenant(),
      c.req.valid('json').refreshToken,
      onNoOrganization(c)
    )
    return c.json(Auth.bodyOf(issued), 200)
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
