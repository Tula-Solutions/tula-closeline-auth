import { describe, expect, test } from 'bun:test'
import { errorBodySchema } from 'tula-closeline-contract'
import { createApp } from '~/app'
import { createReadyDeps } from '~/testing'
import { jwksSchema } from './schema'

describe('GET /.well-known/jwks.json', () => {
  test('serves the public keys with a five minute cache', async () => {
    const app = createApp(await createReadyDeps())

    const response = await app.request('/.well-known/jwks.json')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    const body = jwksSchema.parse(await response.json())
    expect(body.keys).toHaveLength(2)
    expect(JSON.stringify(body)).not.toContain('"d"')
  })

  test('is a 500 with the contract body before the fixed project is bootstrapped', async () => {
    const { createTestDeps } = await import('~/testing')
    const app = createApp(createTestDeps())

    const response = await app.request('/.well-known/jwks.json')

    expect(response.status).toBe(500)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('server.internal')
  })
})
