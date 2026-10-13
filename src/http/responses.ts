import { AUTH_ERRORS, ERRORS, type ErrorDefinition, errorBodySchema } from 'tula-closeline-contract'
import type { ServiceErrorCode } from '~/errors'

/** Every definition this service may answer with, by code: the contract's, never a local one. */
const DEFINITIONS: Readonly<Record<ServiceErrorCode, ErrorDefinition<ServiceErrorCode>>> = {
  ...ERRORS,
  ...AUTH_ERRORS,
}

/**
 * The codes of a request body that fails its schema, is over the body limit or is not JSON (routes
 * that take a body).
 */
export const BODY_ERRORS = [
  'request.invalid',
  'request.too_large',
  'request.unsupported_media_type',
] as const satisfies readonly ServiceErrorCode[]

/**
 * Describes a route's failure responses in OpenAPI from the contract: one response per status,
 * listing the codes the route can answer with at that status (from `AUTH_ERRORS` and the common
 * `ERRORS`), each with its default message as an example body. A route lists the codes its handler
 * and middleware can produce, so a client knows what to handle and nothing it never sees.
 */
export function errorResponses(codes: readonly ServiceErrorCode[]) {
  const byStatus = new Map<number, ErrorDefinition<ServiceErrorCode>[]>()
  for (const code of [...new Set(codes)].sort()) {
    const definition = DEFINITIONS[code]
    byStatus.set(definition.status, [...(byStatus.get(definition.status) ?? []), definition])
  }
  return Object.fromEntries(
    [...byStatus].map(([status, definitions]) => [
      status,
      {
        description: definitions
          .map((definition) => `\`${definition.code}\`: ${definition.message}`)
          .join('\n'),
        content: {
          'application/json': {
            schema: errorBodySchema,
            examples: Object.fromEntries(
              definitions.map(({ code, message }) => [
                code,
                { value: { error: { code, message } } },
              ])
            ),
          },
        },
      },
    ])
  )
}
