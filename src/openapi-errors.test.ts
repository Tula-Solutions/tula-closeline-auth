import { describe, expect, test } from 'bun:test'
import { AUTH_ERRORS, ERRORS } from 'tula-closeline-contract'
import { createApp } from './app'
import { buildOpenApiDocument } from './openapi'
import { createTestDeps } from './testing'

type Response = { description?: string; content?: Record<string, { examples?: object }> }
type Operation = { responses: Record<string, Response> }
type Document = { paths: Record<string, Record<string, Operation>> }

const definitions: Record<string, { status: number; message: string }> = {
  ...ERRORS,
  ...AUTH_ERRORS,
}

const document = buildOpenApiDocument(createApp(createTestDeps())) as unknown as Document

/** The error codes a route's OpenAPI description lists, by the status it lists them under. */
function listed(path: string, method: string): Record<string, string[]> {
  const operation = document.paths[path]?.[method]
  if (!operation) {
    throw new Error(`no ${method} ${path}`)
  }
  const byStatus: Record<string, string[]> = {}
  for (const [status, response] of Object.entries(operation.responses)) {
    const examples = response.content?.['application/json']?.examples
    if (Number(status) >= 400 && examples) {
      byStatus[status] = Object.keys(examples).sort()
    }
  }
  return byStatus
}

/**
 * The codes each route can answer with, read from its handler, the services it calls and the
 * middleware in front of it: a route lists what it can produce, not every code of the contract.
 * A request body adds `request.invalid` and `request.unsupported_media_type`; the body limit is in
 * front of every route, so every route can answer 413 and 500.
 */
const ROUTES: [method: string, path: string, codes: Record<string, string[]>][] = [
  [
    'post',
    '/v1/client/sign-ups',
    {
      '400': ['request.invalid'],
      '413': ['request.too_large'],
      '415': ['request.unsupported_media_type'],
      '422': [
        'email.invalid',
        'password.breached',
        'password.common',
        'password.contains_user_info',
        'password.too_long',
        'password.too_short',
      ],
      '429': ['verification.too_many_attempts'],
      '500': ['server.internal'],
      '503': ['mail.unavailable', 'server.unavailable'],
    },
  ],
  [
    'post',
    '/v1/client/sign-ups/{id}/verify-email',
    {
      '400': ['request.invalid'],
      '404': ['flow.not_found'],
      '409': ['flow.invalid_step'],
      '413': ['request.too_large'],
      '415': ['request.unsupported_media_type'],
      '422': [
        'signup.invitation_invalid',
        'signup.organization_name_invalid',
        'verification.expired',
        'verification.invalid_code',
      ],
      '429': ['verification.too_many_attempts'],
      '500': ['server.internal'],
      '503': ['membership.unavailable'],
    },
  ],
  [
    'post',
    '/v1/client/sign-ups/{id}/resend-code',
    {
      '400': ['request.invalid'],
      '404': ['flow.not_found'],
      '409': ['flow.invalid_step'],
      '413': ['request.too_large'],
      '429': ['verification.too_many_attempts'],
      '500': ['server.internal'],
      '503': ['mail.unavailable'],
    },
  ],
  [
    'post',
    '/v1/client/sign-ins',
    {
      '400': ['request.invalid'],
      '413': ['request.too_large'],
      '415': ['request.unsupported_media_type'],
      '500': ['server.internal'],
    },
  ],
  [
    'post',
    '/v1/client/sign-ins/{id}/password',
    {
      '400': ['request.invalid'],
      '401': ['auth.invalid_credentials'],
      '403': ['auth.no_organization', 'auth.user_banned'],
      '404': ['flow.not_found'],
      '409': ['flow.invalid_step'],
      '410': ['organization.deleted'],
      '413': ['request.too_large'],
      '415': ['request.unsupported_media_type'],
      '429': ['rate.limited'],
      '500': ['server.internal'],
      '503': ['membership.unavailable', 'server.unavailable'],
    },
  ],
  [
    'get',
    '/v1/client/password-policy',
    { '413': ['request.too_large'], '500': ['server.internal'] },
  ],
  [
    'post',
    '/v1/client/sessions/refresh',
    {
      '400': ['request.invalid'],
      '401': [
        'session.expired',
        'session.invalid_token',
        'session.reuse_detected',
        'session.revoked',
      ],
      '403': ['auth.forbidden', 'auth.no_organization', 'auth.user_banned'],
      '410': ['organization.deleted'],
      '413': ['request.too_large'],
      '415': ['request.unsupported_media_type'],
      '500': ['server.internal'],
      '503': ['membership.unavailable'],
    },
  ],
  [
    'post',
    '/v1/client/sessions/sign-out',
    {
      '400': ['request.invalid'],
      '403': ['auth.forbidden'],
      '413': ['request.too_large'],
      '415': ['request.unsupported_media_type'],
      '500': ['server.internal'],
    },
  ],
  [
    'get',
    '/v1/client/sessions',
    {
      '400': ['request.invalid'],
      '401': [
        'auth.token_expired',
        'auth.token_invalid',
        'auth.unauthenticated',
        'session.expired',
        'session.reuse_detected',
        'session.revoked',
      ],
      '413': ['request.too_large'],
      '500': ['server.internal'],
      '503': ['auth.unavailable'],
    },
  ],
  [
    'get',
    '/v1/client/me',
    {
      '401': [
        'auth.token_expired',
        'auth.token_invalid',
        'auth.unauthenticated',
        'session.expired',
        'session.reuse_detected',
        'session.revoked',
      ],
      '413': ['request.too_large'],
      '500': ['server.internal'],
      '503': ['auth.unavailable'],
    },
  ],
  ['get', '/.well-known/jwks.json', { '413': ['request.too_large'], '500': ['server.internal'] }],
  ['get', '/healthz', { '413': ['request.too_large'], '500': ['server.internal'] }],
  ['get', '/readyz', { '413': ['request.too_large'], '500': ['server.internal'] }],
]

describe('each route lists the error codes it can answer with, from the contract', () => {
  test.each(ROUTES)('%s %s', (method, path, codes) => {
    expect(listed(path, method)).toEqual(codes)
  })

  test('every listed code is a contract code, under the status the contract gives it', () => {
    for (const [method, path] of ROUTES) {
      for (const [status, codes] of Object.entries(listed(path, method))) {
        for (const code of codes) {
          expect(definitions[code]?.status).toBe(Number(status))
        }
      }
    }
  })

  test('a listed code carries its contract message as the example answer', () => {
    const response = document.paths['/v1/client/sign-ins/{id}/password']?.post?.responses['401']
    const examples = response?.content?.['application/json']?.examples as Record<
      string,
      { value: unknown }
    >

    expect(examples['auth.invalid_credentials']?.value).toEqual({
      error: {
        code: 'auth.invalid_credentials',
        message: AUTH_ERRORS['auth.invalid_credentials'].message,
      },
    })
    expect(response?.description).toContain('`auth.invalid_credentials`')
  })

  test('a route lists 413 exactly when an over-size request body is refused there', async () => {
    const deps = createTestDeps()
    const app = createApp(deps)
    const body = 'x'.repeat(deps.env.MAX_REQUEST_BODY_BYTES + 1)
    const refused: Record<string, boolean> = {}
    const lists413: Record<string, boolean> = {}

    for (const [method, path, codes] of ROUTES) {
      const response = await app.request(path.replace('{id}', 'a'), {
        method: method.toUpperCase(),
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        body,
      })
      refused[`${method} ${path}`] = response.status === 413
      lists413[`${method} ${path}`] = codes['413'] !== undefined
    }

    expect(refused).toEqual(lists413)
  })
})
