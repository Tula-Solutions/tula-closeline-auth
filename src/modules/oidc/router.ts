import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import {
  AUTH_OPTIONS_ROUTE,
  authOptionsResponseSchema,
  ERRORS,
  GOOGLE_ROUTES,
  googleCompleteRequestSchema,
  googleCompleteResponseSchema,
  googleStartRequestSchema,
  googleStartResponseSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { DEFINITIONS, type ServiceErrorCode } from '~/errors'
import { clientContext, noStore } from '~/http/client'
import { BODY_ERRORS, errorResponses } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Bootstrap from '~/modules/bootstrap/service'
import { readCookie, requireAllowedOrigin, setRefreshCookie } from '~/modules/session/cookie'
import * as Sessions from '~/modules/session/service'
import { clearOidcCookie, oidcCookieName, setOidcCookie } from './cookie'
import * as Oidc from './service'

/** The codes of a contract route that this service defines (core's are not answered here). */
function ownCodes(codes: readonly string[]): ServiceErrorCode[] {
  return codes.filter((code): code is ServiceErrorCode => code in DEFINITIONS)
}

const json = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
})

const originHeaders = z.object({
  origin: z.string().optional().openapi({
    description: 'Required, and exactly one of `SESSION_ALLOWED_ORIGINS`, else `auth.forbidden`.',
  }),
})

const cookieHeader = (what: string) =>
  z.object({
    'set-cookie': z.string().optional().openapi({ description: what }),
  })

const attemptCookie = z.object({
  tula_oidc: z.string().optional().openapi({
    description:
      'The attempt secret, set by `start` (`__Secure-tula_oidc` outside local development).',
  }),
})

const start = createRoute({
  method: 'post',
  path: GOOGLE_ROUTES.start.path,
  tags: ['google'],
  summary: 'Start Sign in with Google',
  description: GOOGLE_ROUTES.start.description,
  request: { headers: originHeaders, body: json(googleStartRequestSchema) },
  responses: {
    200: {
      description: 'Where to send the browser; the attempt secret is in the `Set-Cookie` header.',
      headers: cookieHeader(
        '`__Secure-tula_oidc=<secret>; Path=/v1/client/google/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` (no prefix and no `Secure` in local development).'
      ),
      content: { 'application/json': { schema: googleStartResponseSchema } },
    },
    ...errorResponses([
      ...BODY_ERRORS,
      'auth.forbidden',
      ...ownCodes([...GOOGLE_ROUTES.start.errors, ...GOOGLE_ROUTES.start.commonErrors]),
      'server.internal',
    ]),
  },
})

/** The query is read by hand so that a repeated or odd parameter is still a redirect, never a 400. */
const callbackQuery = z.object({
  code: z.any().optional().openapi({ type: 'string', description: "Google's authorization code." }),
  state: z.any().optional().openapi({ type: 'string', description: 'The state `start` made.' }),
  error: z.any().optional().openapi({ type: 'string', description: "Google's error, if any." }),
})

const callback = createRoute({
  method: 'get',
  path: GOOGLE_ROUTES.callback.path,
  tags: ['google'],
  summary: 'Sign in with Google: the redirect back',
  description: GOOGLE_ROUTES.callback.description,
  request: { query: callbackQuery, cookies: attemptCookie },
  responses: {
    302: {
      description:
        'Every outcome but `oidc.disabled`. Success: to `returnTo`, with the refresh cookie. A new person: to `/sign-up/google?attempt=<id>`. A failure: to `/sign-in?error=<code>`.',
      headers: z.object({
        location: z.string(),
        'set-cookie': z.string().optional().openapi({
          description:
            'On success the refresh cookie (as sign-in sets it) and the cleared attempt cookie.',
        }),
      }),
    },
    // Every other outcome is a 302 (`redirectErrors` in the description), never a status.
    ...errorResponses(['oidc.disabled']),
  },
})

const complete = createRoute({
  method: 'post',
  path: GOOGLE_ROUTES.complete.path,
  tags: ['google'],
  summary: 'Finish Sign in with Google for a new user',
  description: GOOGLE_ROUTES.complete.description,
  request: {
    headers: originHeaders,
    cookies: attemptCookie,
    body: json(googleCompleteRequestSchema),
  },
  responses: {
    200: {
      description:
        'The browser flow response: no refresh token in the body, it is in the `Set-Cookie` header.',
      headers: cookieHeader(
        'The refresh cookie, as sign-in sets it, and the cleared attempt cookie.'
      ),
      content: { 'application/json': { schema: googleCompleteResponseSchema } },
    },
    ...errorResponses([
      ...BODY_ERRORS,
      'auth.forbidden',
      // The contract also lists codes this service never answers here: the provider is not
      // called, a refused Invitation is a mismatch, and the Organization is read at sign-in only.
      'oidc.disabled',
      'oidc.state_invalid',
      'oidc.invitation_mismatch',
      'signup.organization_name_invalid',
      'membership.unavailable',
      'rate.limited',
      'server.unavailable',
      'server.internal',
    ]),
  },
})

const options = createRoute({
  method: 'get',
  path: AUTH_OPTIONS_ROUTE.path,
  tags: ['google'],
  summary: 'Which sign-in providers are on',
  description: AUTH_OPTIONS_ROUTE.description,
  responses: {
    200: {
      description: 'The providers.',
      content: { 'application/json': { schema: authOptionsResponseSchema } },
    },
    ...errorResponses(ownCodes(['server.internal', ...AUTH_OPTIONS_ROUTE.commonErrors])),
  },
})

/** A request's source for the rate limits: the last `X-Forwarded-For` hop (the balancer's own). */
function sourceOf(c: Context<AppEnv>): string {
  const hops = (c.req.header('x-forwarded-for') ?? '').split(',')
  const last = hops.at(-1)?.trim() ?? ''
  return last === '' ? 'unknown' : last.slice(0, 64)
}

/** The first value of a query parameter as text, cut to a bounded length. */
function param(c: Context<AppEnv>, name: string): string | undefined {
  const value = c.req.query(name)
  return value === undefined ? undefined : value.slice(0, 4096)
}

/** Sign in with Google: start, callback, complete and the auth options. */
export function createOidcRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  const tenant = () => Bootstrap.requireTenant(container)
  const origin = (c: Context<AppEnv>) =>
    requireAllowedOrigin(container.env, {
      origin: c.req.header('origin'),
      fetchSite: c.req.header('sec-fetch-site'),
    })
  const cookieSecret = (c: Context<AppEnv>) =>
    readCookie(c.req.header('cookie'), oidcCookieName(container.env))

  router.openapi(start, async (c) => {
    noStore(c)
    origin(c)
    await Oidc.limitSource(container, 'start', sourceOf(c))
    const started = await Oidc.start(container, tenant(), c.req.valid('json'))
    c.header('Set-Cookie', setOidcCookie(container.env, started.cookieSecret))
    return c.json({ authorizationUrl: started.authorizationUrl }, 200)
  })

  router.openapi(callback, async (c) => {
    noStore(c)
    const context = clientContext(container, c)
    let spent = false
    try {
      await Oidc.limitSource(container, 'callback', sourceOf(c))
      const result = await Oidc.callback(
        container,
        tenant(),
        { code: param(c, 'code'), state: param(c, 'state'), error: param(c, 'error') },
        cookieSecret(c),
        {
          report: context.report,
          onSpent: () => {
            spent = true
          },
        }
      )
      if (result.session) {
        c.header(
          'Set-Cookie',
          setRefreshCookie(container.env, result.session, container.clock.now())
        )
      }
      if (result.clearCookie) {
        c.header('Set-Cookie', clearOidcCookie(container.env), { append: true })
      }
      return c.redirect(result.location, 302)
    } catch (error) {
      if (error instanceof AppError && error.code === 'oidc.disabled') {
        throw error
      }
      // Every other outcome is a redirect to the sign-in page. The attempt is spent by then
      // (but a foreign request with no valid state must not clear someone else's cookie).
      const code = error instanceof AppError ? error.code : ERRORS['server.internal'].code
      if (!(error instanceof AppError)) {
        context.report(error, 500)
      }
      if (spent || (code !== 'oidc.state_invalid' && code !== 'rate.limited')) {
        c.header('Set-Cookie', clearOidcCookie(container.env))
      }
      return c.redirect(Oidc.errorLocation(code), 302)
    }
  })

  router.openapi(complete, async (c) => {
    noStore(c)
    origin(c)
    await Oidc.limitSource(container, 'complete', sourceOf(c))
    const done = await Oidc.complete(
      container,
      tenant(),
      c.req.valid('json'),
      cookieSecret(c),
      clientContext(container, c)
    )
    c.header('Set-Cookie', setRefreshCookie(container.env, done.session, container.clock.now()))
    c.header('Set-Cookie', clearOidcCookie(container.env), { append: true })
    return c.json({ ...done, session: Sessions.browserBodyOf(done.session) }, 200)
  })

  router.openapi(options, async (c) => {
    await Oidc.limitSource(container, 'options', sourceOf(c))
    return c.json({ providers: { google: container.oidc.enabled } }, 200)
  })

  return router
}
