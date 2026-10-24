import { expect, test } from 'bun:test'
import { createApp } from './app'
import { SERVICE } from './info'
import { buildOpenApiDocument } from './openapi'
import { createTestDeps } from './testing'

type ServedDocument = {
  openapi: string
  info: { title: string }
  paths: Record<string, { get: { responses: Record<string, unknown> } }>
}

test('the app serves its OpenAPI document describing every route and the error body', async () => {
  const app = createApp(createTestDeps())

  const response = await app.request('/openapi.json')

  expect(response.status).toBe(200)
  const document = (await response.json()) as ServedDocument
  expect(document.openapi).toBe('3.1.0')
  expect(document.info.title).toBe(SERVICE)
  expect(Object.keys(document.paths).sort()).toEqual([
    '/.well-known/jwks.json',
    '/healthz',
    '/readyz',
    '/v1/client/auth-options',
    '/v1/client/google/callback',
    '/v1/client/google/complete',
    '/v1/client/google/start',
    '/v1/client/me',
    '/v1/client/password-policy',
    '/v1/client/sessions',
    '/v1/client/sessions/refresh',
    '/v1/client/sessions/sign-out',
    '/v1/client/sign-ins',
    '/v1/client/sign-ins/{id}/password',
    '/v1/client/sign-ups',
    '/v1/client/sign-ups/{id}/resend-code',
    '/v1/client/sign-ups/{id}/verify-email',
    '/v1/token',
  ])
  expect(document.paths['/healthz']?.get.responses['500']).toBeDefined()
  expect(document.paths['/readyz']?.get.responses['503']).toBeDefined()
  expect(JSON.stringify(document.paths['/healthz']?.get.responses['500'])).toContain('code')
})

test('the document written by the script is the document the app serves', async () => {
  const app = createApp(createTestDeps())

  const served = await (await app.request('/openapi.json')).json()

  expect(JSON.parse(JSON.stringify(buildOpenApiDocument(app)))).toEqual(served)
})
