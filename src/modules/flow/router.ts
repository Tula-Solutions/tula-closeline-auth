import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { clientContext, noStore } from '~/http/client'
import { BODY_ERRORS, errorResponses } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import * as Bootstrap from '~/modules/bootstrap/service'
import { PASSWORD_POLICY } from '~/modules/password/rules'
import {
  ATTEMPT_SECRET_HEADER,
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
  'x-tula-client': z.enum(['web', 'ios', 'android', 'server']).optional(),
})
const startHeaders = z.object({
  'x-tula-client': z.enum(['web', 'ios', 'android', 'server']).optional().openapi({
    description: 'The kind of client; defaults to web.',
  }),
})
const idParams = z.object({ id: z.string().max(64) })

const ok = {
  200: {
    description: 'The attempt and its next step; tokens once it is complete.',
    content: { 'application/json': { schema: flowResponseSchema } },
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
    'neither gets a session. If the core service cannot answer, the answer is 503 ' +
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
    return c.json(
      await Flow.verifyEmail(container, tenant(), ref(c, id), code, clientContext(container, c)),
      200
    )
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
    return c.json(
      await Flow.submitPassword(
        container,
        tenant(),
        ref(c, c.req.valid('param').id),
        c.req.valid('json'),
        clientContext(container, c)
      ),
      200
    )
  })
  router.openapi(policy, (c) =>
    c.json({ minLength: PASSWORD_POLICY.minLength, maxLength: PASSWORD_POLICY.maxLength }, 200)
  )
  return router
}
