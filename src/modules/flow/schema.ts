import { z } from '@hono/zod-openapi'
import { roleSchema } from 'tula-closeline-contract'

/** The kinds of attempt this service runs: a sign-up and a sign-in with an email and password. */
export const FLOW_KINDS = ['sign_in', 'sign_up'] as const
/** The kind of a flow attempt. */
export type FlowKind = (typeof FLOW_KINDS)[number]

/** The steps an attempt can wait on, or `complete` once its session exists. */
export const FLOW_STATUSES = ['needs_email_verification', 'needs_password', 'complete'] as const
/** The step an attempt is on. */
export type FlowStatus = (typeof FLOW_STATUSES)[number]

/** The header that carries an attempt's secret; an attempt id alone does nothing. */
export const ATTEMPT_SECRET_HEADER = 'x-tula-attempt'
/** The header that says which kind of client is calling. */
export const CLIENT_HEADER = 'x-tula-client'
/** Prefix of an attempt secret. */
export const ATTEMPT_SECRET_PREFIX = 'tula_at_'

/** The kinds of client that hold a session. */
export const clientSchema = z.enum(['web', 'ios', 'android', 'server'])

/** What a sign-up request is: a person, and exactly one way to get an Organization. */
export const signUpRequestSchema = z
  .strictObject({
    email: z.string().min(1).max(320).openapi({ example: 'maya@northline.app' }),
    password: z.string().min(1).max(16_384),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    organizationName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: 'Creates this Organization with the new user as its Owner.' }),
    invitationToken: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .openapi({ description: 'Joins the Organization that issued this invitation.' }),
  })
  .refine(
    (body) => (body.organizationName === undefined) !== (body.invitationToken === undefined),
    {
      message: 'Send exactly one of organizationName and invitationToken.',
      path: ['organizationName'],
    }
  )
  .openapi('SignUpRequest')

/** The emailed code: six digits. */
export const verifyEmailRequestSchema = z
  .strictObject({ code: z.string().regex(/^\d{6}$/, 'The code is six digits.') })
  .openapi('VerifyEmailRequest')

/** Starting a sign-in names the account; whether it exists is not looked at yet. */
export const signInRequestSchema = z
  .strictObject({ identifier: z.string().min(1).max(320) })
  .openapi('SignInRequest')

/** The password step of a sign-in. */
export const passwordRequestSchema = z
  .strictObject({ password: z.string().min(1).max(16_384) })
  .openapi('PasswordRequest')

/** A refresh token, to trade for new tokens or to end its session. */
export const refreshRequestSchema = z
  .strictObject({ refreshToken: z.string().min(1).max(512) })
  .openapi('RefreshRequest')

/** The tokens of a signed-in session. Secrets: never log or cache a response that holds them. */
export const sessionTokensSchema = z
  .object({
    sessionId: z.string(),
    accessToken: z.string(),
    accessTokenExpiresAt: z.iso.datetime(),
    refreshToken: z.string(),
    organization: z.object({ id: z.string(), role: roleSchema }),
  })
  .openapi('SessionTokens')

/** Where an attempt stands and what it needs next. */
export const stepSchema = z
  .object({
    status: z.enum(FLOW_STATUSES),
    strategies: z.array(z.enum(['email_code', 'password'])).optional(),
    destination: z.string().optional(),
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .openapi('FlowStep')

/** The answer to every step of a sign-up or sign-in. */
export const flowResponseSchema = z
  .object({
    id: z.string(),
    kind: z.enum(FLOW_KINDS),
    expiresAt: z.iso.datetime(),
    step: stepSchema,
    attemptSecret: z
      .string()
      .optional()
      .openapi({ description: 'Returned once, when the attempt starts.' }),
    session: sessionTokensSchema.optional(),
  })
  .openapi('FlowResponse')

/** What a client may show about the password rules. */
export const passwordPolicySchema = z
  .object({ minLength: z.number().int(), maxLength: z.number().int() })
  .openapi('PasswordPolicy')

/** The signed-in user. */
export const meSchema = z
  .object({
    id: z.string(),
    email: z.string().nullable(),
    emailVerifiedAt: z.iso.datetime().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    bannedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    organization: z.object({ id: z.string(), role: roleSchema }),
  })
  .openapi('Me')

/** One of the user's sessions. */
export const sessionSummarySchema = z
  .object({
    id: z.string(),
    client: clientSchema,
    createdAt: z.iso.datetime(),
    lastActiveAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .openapi('SessionSummary')
