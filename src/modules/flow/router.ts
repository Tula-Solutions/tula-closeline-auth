import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { Container } from '~/container'
import { clientContext, noStore } from '~/http/client'
import { BODY_ERRORS, errorResponses } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Bootstrap from '~/modules/bootstrap/service'
import { PASSWORD_POLICY } from '~/modules/password/rules'
import { setRefreshCookie } from '~/modules/session/cookie'
import * as Sessions from '~/modules/session/service'
import {
  ATTEMPT_SECRET_HEADER,
  browserFlowResponseSchema,
  clientHeaderSchema,
  flowResponseSchema,
  passwordPolicySchema,
  passwordRequestSchema,
  signInRequestSchema,
  signUpRequestSchema,
  verifyEmailRequestSchema,
} from './schema'
import * as Flow from './service'

const attemptHeaders = z.object({
  [ATTEMPT_SECRET_HEADER]: z
    .string()
    .optional()
    .openapi({ description: 'The attempt secret returned when the attempt started.' }),
  'x-tula-client': clientHeaderSchema.optional(),
})
const startHeaders = z.object({
  'x-tula-client': clientHeaderSchema.optional().openapi({
    description:
      'The kind of client; defaults to web. `browser` gets the refresh token in a ' +
      '`Set-Cookie` header instead of the body (see the `BrowserFlowResponse` shape).',
  }),
})
const idParams = z.object({ id: z.string().max(64) })

const ok = {
  200: {
    description:
      'The attempt and its next step; tokens once it is complete. Two shapes, by client type: ' +
      '`FlowResponse` (every client type but `browser`: `session.refreshToken` is in the body) ' +
      'and `BrowserFlowResponse` (client type `browser`: no refresh token in the body; it is ' +
      'set in the `Set-Cookie` header of the response that completes the attempt).',
    headers: z.object({
      'set-cookie': z
        .string()
        .optional()
        .openapi({
          description:
            'Client type `browser`, on the response that completes the attempt only: the refresh ' +
            'cookie `__Secure-tula_refresh` (`tula_refresh` in local development with ' +
            '`SESSION_COOKIE_INSECURE`), `Path=/v1/client/sessions/; Max-Age=<remaining session ' +
            'lifetime>; HttpOnly; Secure; SameSite=Strict`, no `Domain`. A completed sign-in also ' +
            'sets the known-device cookie `__Secure-tula_known_device` (`tula_known_device` in ' +
            'local development with `SESSION_COOKIE_INSECURE`), `Path=/v1/client/sign-ins; ' +
            'Max-Age=7776000; HttpOnly; Secure; SameSite=Strict`, no `Domain`: a signed value ' +
            'that lets this device sign in to this account while others guess at its address.',
        }),
    }),
    content: {
      'application/json': {
        schema: z.union([flowResponseSchema, browserFlowResponseSchema]),
      },
    },
  },
}

const json = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
})

const signUp = createRoute({
  method: 'post',
  path: '/v1/client/sign-ups',
  tags: ['sign-up'],
  summary: 'Start a sign-up',
  description:
    'Emails a six-digit code. Nothing but the attempt is created until the code is verified. ' +
    'Send exactly one of `organizationName` (the user becomes the Owner of a new Organization) ' +
    'or `invitationToken` (the user joins the inviting Organization). An address that already ' +
    'has an account gets the same answer and a notice instead of a code.',
  request: { headers: startHeaders, body: json(signUpRequestSchema) },
  responses: {
    ...ok,
    ...errorResponses([
      ...BODY_ERRORS,
      'email.invalid',
      'password.too_short',
      'password.too_long',
      'password.contains_user_info',
      'password.common',
      'password.breached',
      'verification.too_many_attempts',
      'mail.unavailable',
      'server.unavailable',
      'server.internal',
    ]),
  },
})

const verifyEmail = createRoute({
  method: 'post',
  path: '/v1/client/sign-ups/{id}/verify-email',
  tags: ['sign-up'],
  summary: 'Verify the emailed code',
  description:
    'Creates the account, its Organization membership and its first session in one step. If ' +
    'the membership cannot be made, no account is created and the code still works.',
  request: { params: idParams, headers: attemptHeaders, body: json(verifyEmailRequestSchema) },
  responses: {
    ...ok,
    ...errorResponses([
      ...BODY_ERRORS,
      'flow.not_found',
      'flow.invalid_step',
      'verification.invalid_code',
      'verification.expired',
      'verification.too_many_attempts',
      'signup.invitation_invalid',
      'signup.organization_name_invalid',
      'membership.unavailable',
      'server.internal',
    ]),
  },
})

const resend = createRoute({
  method: 'post',
  path: '/v1/client/sign-ups/{id}/resend-code',
  tags: ['sign-up'],
  summary: 'Send the code again',
  request: { params: idParams, headers: attemptHeaders },
  responses: {
    ...ok,
    ...errorResponses([
      'request.invalid',
      'flow.not_found',
      'flow.invalid_step',
      'verification.too_many_attempts',
      'mail.unavailable',
      'server.internal',
    ]),
  },
})

const signIn = createRoute({
  method: 'post',
  path: '/v1/client/sign-ins',
  tags: ['sign-in'],
  summary: 'Start a sign-in',
  description: 'The answer is the same whether or not the address has an account.',
  request: { headers: startHeaders, body: json(signInRequestSchema) },
  responses: { ...ok, ...errorResponses([...BODY_ERRORS, 'server.internal']) },
})

const password = createRoute({
  method: 'post',
  path: '/v1/client/sign-ins/{id}/password',
  tags: ['sign-in'],
  summary: 'Submit the password',
  description:
    'Completes the sign-in with tokens. An account with no Organization is refused with ' +
    '`auth.no_organization`, and one whose Organization was deleted with `organization.deleted`; ' +
    'neither gets a session. Wrong passwords are counted per address (about 11, then one every 15 ' +
    'minutes) and refused with 429 `rate.limited` and `Retry-After`, except from a device that holds ' +
    'a valid known-device cookie for the account (set by an earlier sign-in), which has a counter ' +
    'of its own. If the core service cannot answer, the answer is 503 ' +
    '`membership.unavailable` with `Retry-After`: nothing is counted against the account and ' +
    'the same attempt can be submitted again.',
  request: { params: idParams, headers: attemptHeaders, body: json(passwordRequestSchema) },
  responses: {
    ...ok,
    ...errorResponses([
      ...BODY_ERRORS,
      'flow.not_found',
      'flow.invalid_step',
      'auth.invalid_credentials',
      'auth.user_banned',
      'auth.no_organization',
      'organization.deleted',
      'rate.limited',
      'membership.unavailable',
      'server.unavailable',
      'server.internal',
    ]),
  },
})

const policy = createRoute({
  method: 'get',
  path: '/v1/client/password-policy',
  tags: ['sign-up'],
  summary: 'The password rules',
  responses: {
    200: {
      description: 'The length limits of a password.',
      content: { 'application/json': { schema: passwordPolicySchema } },
    },
    ...errorResponses(['server.internal']),
  },
})

/** The answer to a step in the shape the client type receives; sets the refresh cookie if due. */
function shaped(
  container: Container,
  c: Context<AppEnv>,
  context: Flow.ClientContext,
  result: Flow.FlowResult
) {
  // The device cookie is a header, never part of the body.
  const { session, deviceCookie, ...body } = result
  if (session === undefined) {
    return body
  }
  if (!context.cookie) {
    return { ...body, session: Sessions.bodyOf(session) }
  }
  c.header('Set-Cookie', setRefreshCookie(container.env, session, container.clock.now()))
  if (deviceCookie !== undefined) {
    c.header('Set-Cookie', deviceCookie, { append: true })
  }
  return { ...body, session: Sessions.browserBodyOf(session) }
}

/** Sign-up, sign-in and the password policy. */
export function createFlowRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  const tenant = () => Bootstrap.requireTenant(container)
  const ref = (c: { req: { header: (n: string) => string | undefined } }, id: string) => ({
    id,
    secret: c.req.header(ATTEMPT_SECRET_HEADER),
  })

  router.openapi(signUp, async (c) => {
    noStore(c)
    return c.json(
      await Flow.signUp(container, tenant(), c.req.valid('json'), clientContext(container, c)),
      200
    )
  })
  router.openapi(verifyEmail, async (c) => {
    noStore(c)
    const { id } = c.req.valid('param')
    const { code } = c.req.valid('json')
    const context = clientContext(container, c)
    const result = await Flow.verifyEmail(container, tenant(), ref(c, id), code, context)
    return c.json(shaped(container, c, context, result), 200)
  })
  router.openapi(resend, async (c) => {
    noStore(c)
    return c.json(await Flow.resendCode(container, tenant(), ref(c, c.req.valid('param').id)), 200)
  })
  router.openapi(signIn, async (c) => {
    noStore(c)
    return c.json(
      await Flow.signIn(container, tenant(), c.req.valid('json'), clientContext(container, c)),
      200
    )
  })
  router.openapi(password, async (c) => {
    noStore(c)
    const context = clientContext(container, c)
    const result = await Flow.submitPassword(
      container,
      tenant(),
      ref(c, c.req.valid('param').id),
      c.req.valid('json'),
      context
    )
    return c.json(shaped(container, c, context, result), 200)
  })
  router.openapi(policy, (c) =>
    c.json({ minLength: PASSWORD_POLICY.minLength, maxLength: PASSWORD_POLICY.maxLength }, 200)
  )
  return router
}
