import { z } from '@hono/zod-openapi'

/**
 * The body of `POST /v1/token`: the API key's secret. Any text up to a bound is accepted, so a
 * malformed key gets the same refusal as an unknown one (ADR 0023) and not a 400 that tells the
 * caller what a key looks like.
 */
export const tokenRequestSchema = z
  .strictObject({
    apiKey: z.string().min(1).max(512).openapi({
      description:
        'The API key secret, shown once when the key was created (`clk_` and 43 characters).',
    }),
  })
  .openapi('ApiKeyTokenRequest')

/** The answer of `POST /v1/token`: a 10 minute access token, with no refresh token. */
export const tokenResponseSchema = z
  .object({
    accessToken: z.string().openapi({ description: 'Send as `Authorization: Bearer <token>`.' }),
    accessTokenExpiresAt: z.iso.datetime().openapi({ description: 'About 10 minutes from now.' }),
  })
  .openapi('ApiKeyTokenResponse')
