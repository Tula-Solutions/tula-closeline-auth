import { describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import { formatId } from 'tula-closeline-contract'
import { createStaticKeySet, createTokenVerifier } from 'tula-closeline-kit'
import { createApp } from '~/app'
import { publicUrl } from '~/env'
import { jwksSchema } from '~/modules/jwks/schema'
import { createReadyDeps } from '~/testing'

const SECRET = `clk_${'k'.repeat(43)}`
const organizationId = formatId('org', crypto.randomUUID())
const apiKeyId = formatId('akey', crypto.randomUUID())

async function setup() {
  const deps = await createReadyDeps({ env: { TRUSTED_PROXY_HOPS: '1' } })
  deps.membership.addApiKey(SECRET, {
    apiKeyId,
    organizationId,
    scopes: ['prospects:read', 'playbook:write'],
    roleCeiling: 'admin',
    expiresAt: null,
  })
  const app = createApp(deps)
  const exchange = (apiKey: unknown, source = '203.0.113.7') =>
    app.request('/v1/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': source },
      body: JSON.stringify({ apiKey }),
    })
  return { deps, app, exchange }
}

describe('POST /v1/token', () => {
  test('a valid key gets a 10 minute token the kit verifies as that key', async () => {
    const { deps, app, exchange } = await setup()
    const response = await exchange(SECRET)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = (await response.json()) as { accessToken: string; accessTokenExpiresAt: string }
    const keys = await createStaticKeySet(
      jwksSchema.parse(await (await app.request('/.well-known/jwks.json')).json())
    )
    const verifier = createTokenVerifier({
      issuer: publicUrl(deps.env),
      audience: deps.env.TOKEN_AUDIENCE,
      keys,
      clock: deps.clock,
    })
    const verified = await verifier.verify(body.accessToken)
    expect(verified).toMatchObject({
      actor: 'api_key',
      apiKeyId,
      organizationId,
      region: deps.env.REGION,
      scopes: ['prospects:read', 'playbook:write'],
    })
    expect('role' in verified).toBe(false)
    expect(verified.expiresAt.getTime() - verified.issuedAt.getTime()).toBe(600_000)
    expect(body.accessTokenExpiresAt).toBe(verified.expiresAt.toISOString())
    const claims = decodeJwt(body.accessToken)
    expect(claims.sub).toBe(apiKeyId)
    expect(claims).not.toHaveProperty('role')
    expect(claims).not.toHaveProperty('sid')
    expect(JSON.stringify(claims)).not.toContain(SECRET)
  })

  test('an unknown, a revoked, an expired and a malformed key get one identical refusal', async () => {
    const { deps, exchange } = await setup()
    const revoked = `clk_${'r'.repeat(43)}`
    deps.membership.addApiKey(revoked, {
      apiKeyId: formatId('akey', crypto.randomUUID()),
      organizationId,
      scopes: ['prospects:read'],
      roleCeiling: 'rep',
      expiresAt: null,
    })
    deps.membership.revokeApiKey(revoked)
    const expired = `clk_${'e'.repeat(43)}`
    deps.membership.addApiKey(expired, {
      apiKeyId: formatId('akey', crypto.randomUUID()),
      organizationId,
      scopes: ['prospects:read'],
      roleCeiling: 'rep',
      expiresAt: '2025-01-01T00:00:00.000Z',
    })
    const answers = await Promise.all(
      [`clk_${'u'.repeat(43)}`, revoked, expired, 'not-a-key'].map(async (key) => {
        const response = await exchange(key)
        return { status: response.status, body: await response.json() }
      })
    )
    for (const answer of answers) {
      expect(answer.status).toBe(401)
      expect(answer.body).toEqual(answers[0]?.body as object)
    }
    expect(answers[0]?.body).toMatchObject({ error: { code: 'apikey.invalid' } })
  })

  test('a body without a key is a request error', async () => {
    const { exchange } = await setup()
    const response = await exchange(undefined)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'request.invalid' } })
  })

  test('core rate limit passes through with its Retry-After', async () => {
    const { deps, exchange } = await setup()
    deps.membership.rateLimitApiKey(SECRET, 7_000)
    const response = await exchange(SECRET)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(await response.json()).toMatchObject({ error: { code: 'apikey.rate_limited' } })
  })

  test('no token is minted while core cannot verify: 503 with Retry-After', async () => {
    const { deps, exchange } = await setup()
    deps.membership.breakDown(true)
    const response = await exchange(SECRET)
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).not.toBeNull()
    expect(await response.json()).toMatchObject({ error: { code: 'membership.unavailable' } })
  })

  test('a core outage is not counted against the source', async () => {
    const { deps, exchange } = await setup()
    deps.membership.breakDown(true)
    for (let i = 0; i < 30; i += 1) {
      expect((await exchange(SECRET, '198.51.100.9')).status).toBe(503)
    }
    deps.membership.breakDown(false)
    expect((await exchange(SECRET, '198.51.100.9')).status).toBe(200)
  })

  test('failures are counted per source: one source is slowed, another is not', async () => {
    const { deps, exchange } = await setup()
    const bad = `clk_${'b'.repeat(43)}`
    let last = 0
    for (let i = 0; i < 40 && last !== 429; i += 1) {
      last = (await exchange(bad, '198.51.100.1')).status
    }
    expect(last).toBe(429)
    const callsBefore = deps.membership.calls.verifyApiKey
    const blocked = await exchange(SECRET, '198.51.100.1')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await blocked.json()).toMatchObject({ error: { code: 'apikey.rate_limited' } })
    // A blocked source never reaches core.
    expect(deps.membership.calls.verifyApiKey).toBe(callsBefore)
    expect((await exchange(SECRET, '198.51.100.2')).status).toBe(200)
  })

  test('the secret is never logged or reported', async () => {
    const { deps, exchange } = await setup()
    await exchange(SECRET)
    deps.membership.revokeApiKey(SECRET)
    await exchange(SECRET)
    deps.membership.breakDown(true)
    deps.membership.addApiKey(`clk_${'z'.repeat(43)}`, {
      apiKeyId,
      organizationId,
      scopes: ['prospects:read'],
      roleCeiling: 'rep',
      expiresAt: null,
    })
    await exchange(`clk_${'z'.repeat(43)}`)
    const everything = JSON.stringify([deps.logLines, deps.reported.map((r) => String(r.error))])
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain('z'.repeat(43))
  })

  test('an API key token never authenticates a person: the session routes refuse it', async () => {
    const { app, exchange } = await setup()
    const { accessToken } = (await (await exchange(SECRET)).json()) as { accessToken: string }
    const reply = await app.request('/v1/client/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(reply.status).toBe(401)
    expect(await reply.json()).toMatchObject({ error: { code: 'auth.token_invalid' } })
  })
})
