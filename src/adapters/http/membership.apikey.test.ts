import { afterAll, describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { describeError } from '~/describe-error'
import { ApiKeyRateLimited, ApiKeyRefused, MembershipUnavailable } from '~/ports/membership'
import { type FakeCore, startFakeCore } from '~/testing/fake-core'
import { createHttpMembership } from './membership'

const started: FakeCore[] = []
afterAll(async () => {
  await Promise.all(started.map((core) => core.stop()))
})

const secret = () => `clk_${'a'.repeat(43)}`

function connect() {
  const core = startFakeCore()
  started.push(core)
  const adapter = createHttpMembership({
    baseUrl: core.url,
    token: core.secret,
    environment: 'local',
    retryDelayMs: () => 0,
  })
  return { core, adapter }
}

describe('verifying an API key with core', () => {
  test('a good key answers what core says it stands for', async () => {
    const { core, adapter } = connect()
    const organizationId = formatId('org', crypto.randomUUID())
    const apiKeyId = core.addApiKey(secret(), { organizationId, scopes: ['prospects:read'] })
    const verified = await adapter.verifyApiKey(secret())
    expect(verified).toMatchObject({ apiKeyId, organizationId, scopes: ['prospects:read'] })
    expect(core.requests.at(-1)?.path).toBe('/internal/api-keys/verify')
    expect(core.requests.at(-1)?.body).toEqual({ secret: secret() })
    expect(core.requests.at(-1)?.headers.authorization).toBe(`Bearer ${core.secret}`)
  })

  test('an unknown key is refused as invalid, and not retried', async () => {
    const { core, adapter } = connect()
    const error = await adapter.verifyApiKey(secret()).catch((e) => e)
    expect(error).toBeInstanceOf(ApiKeyRefused)
    expect(error.reason).toBe('invalid')
    expect(core.requests).toHaveLength(1)
  })

  test('a revoked key is refused as revoked', async () => {
    const { core, adapter } = connect()
    core.addApiKey(secret(), {
      organizationId: formatId('org', crypto.randomUUID()),
      scopes: ['prospects:read'],
    })
    core.revokeApiKey(secret())
    const error = await adapter.verifyApiKey(secret()).catch((e) => e)
    expect(error).toBeInstanceOf(ApiKeyRefused)
    expect(error.reason).toBe('revoked')
  })

  test('a secret of a shape no key has never reaches core', async () => {
    const { core, adapter } = connect()
    const error = await adapter.verifyApiKey('nope').catch((e) => e)
    expect(error).toBeInstanceOf(ApiKeyRefused)
    expect(core.requests).toHaveLength(0)
  })

  test('core 429 passes through with its pause, without a retry', async () => {
    const { core, adapter } = connect()
    core.script({
      kind: 'json',
      status: 429,
      body: { error: { code: 'apikey.rate_limited', message: 'Slow down.' } },
      headers: { 'retry-after': '7' },
    })
    const error = await adapter.verifyApiKey(secret()).catch((e) => e)
    expect(error).toBeInstanceOf(ApiKeyRateLimited)
    expect(error.retryAfterMs).toBe(7000)
    expect(core.requests).toHaveLength(1)
  })

  test('a core outage is retried once, then unavailable', async () => {
    const { core, adapter } = connect()
    core.breakDown(true)
    const error = await adapter.verifyApiKey(secret()).catch((e) => e)
    expect(error).toBeInstanceOf(MembershipUnavailable)
    expect(core.requests).toHaveLength(2)
  })

  test('a rejected service token is a fault, not a refusal of the key', async () => {
    const { core, adapter } = connect()
    core.script({
      kind: 'json',
      status: 401,
      body: { error: { code: 'auth.unauthenticated', message: 'No.' } },
    })
    const error = await adapter.verifyApiKey(secret()).catch((e) => e)
    expect(error).not.toBeInstanceOf(ApiKeyRefused)
  })

  test('the secret appears in no error', async () => {
    const { core, adapter } = connect()
    core.breakDown(true)
    const error = await adapter.verifyApiKey(secret()).catch((e) => e)
    expect(`${String(error)} ${JSON.stringify(describeError(error))}`).not.toContain(secret())
  })
})
