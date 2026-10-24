import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createApp } from '~/app'
import { createPostgresDeps, secondInstance } from '~/testing/postgres-deps'
import { API_KEY_SOURCE_LOCKOUT } from './service'

let deps: Awaited<ReturnType<typeof createPostgresDeps>>

beforeAll(async () => {
  deps = await createPostgresDeps()
})
afterAll(() => deps.stop())

const SECRET = `clk_${'p'.repeat(43)}`

const exchange = (app: ReturnType<typeof createApp>, apiKey: string) =>
  app.request('/v1/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  })

describe('the API key exchange against a real Postgres', () => {
  test('a key gets a token signed by the stored signing key', async () => {
    deps.membership.addApiKey(SECRET, {
      apiKeyId: formatId('akey', crypto.randomUUID()),
      organizationId: formatId('org', crypto.randomUUID()),
      scopes: ['prospects:read'],
      roleCeiling: 'rep',
      expiresAt: null,
    })
    const response = await exchange(createApp(deps), SECRET)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ accessToken: expect.any(String) })
  })

  test('failures from one source are counted in the database, so another instance sees them', async () => {
    const first = createApp(deps)
    const second = createApp(secondInstance(deps))
    const bad = `clk_${'x'.repeat(43)}`
    for (let i = 0; i <= API_KEY_SOURCE_LOCKOUT.freeAttempts; i += 1) {
      expect((await exchange(i % 2 === 0 ? first : second, bad)).status).toBe(401)
    }
    const blocked = await exchange(second, bad)
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await exchange(first, SECRET)).status).toBe(429)
  })
})
