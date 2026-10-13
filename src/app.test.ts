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
  expect(Object.keys(document.paths).sort()).toEqual(['/healthz', '/readyz'])
  expect(document.paths['/healthz']?.get.responses['500']).toBeDefined()
  expect(document.paths['/readyz']?.get.responses['503']).toBeDefined()
  expect(JSON.stringify(document.paths['/healthz']?.get.responses['500'])).toContain('code')
})

test('the document written by the script is the document the app serves', async () => {
  const app = createApp(createTestDeps())

  const served = await (await app.request('/openapi.json')).json()

  expect(JSON.parse(JSON.stringify(buildOpenApiDocument(app)))).toEqual(served)
})
