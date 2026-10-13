import { describe, expect, test } from 'bun:test'
import { decodeProtectedHeader } from 'jose'
import { formatId } from 'tula-closeline-contract'
import {
  createRemoteKeySet,
  createStaticKeySet,
  createTokenVerifier,
  MAX_TOKEN_LENGTH,
  TokenVerificationError,
} from 'tula-closeline-kit'
import { createApp } from '~/app'
import { publicUrl } from '~/env'
import * as Bootstrap from '~/modules/bootstrap/service'
import { jwksSchema } from '~/modules/jwks/schema'
import * as Jwks from '~/modules/jwks/service'
import type { Membership } from '~/ports/membership'
import { createReadyDeps } from '~/testing'
import * as Tokens from './service'

const userId = crypto.randomUUID()
const membership: Membership = {
  organizationId: formatId('org', crypto.randomUUID()),
  role: 'owner',
}

async function setup() {
  const deps = await createReadyDeps()
  const tenant = Bootstrap.requireTenant(deps)
  const app = createApp(deps)
  const session = (): Tokens.TokenSession => ({
    id: crypto.randomUUID(),
    userId,
    authenticatedAt: deps.clock.now(),
    authMethods: ['pwd'],
  })
  const issue = async () => {
    const sign = await Tokens.signer(deps, tenant)
    return (await sign(session(), membership, deps.clock.now())).accessToken
  }
  return { deps, tenant, app, issue }
}

describe('an access token issued by this service, checked with the kit verifier', () => {
  test('verifies against a key set built from this service’s own JWKS response', async () => {
    const { deps, app, issue } = await setup()
    const jwks = jwksSchema.parse(await (await app.request('/.well-known/jwks.json')).json())
    const verifier = createTokenVerifier({
      issuer: publicUrl(deps.env),
      audience: deps.env.TOKEN_AUDIENCE,
      keys: await createStaticKeySet(jwks),
      clock: deps.clock,
    })

    const verified = await verifier.verify(await issue())

    expect(verified.userId).toBe(formatId('usr', userId))
    expect(verified.organizationId).toBe(membership.organizationId)
    expect(verified.role).toBe('owner')
    expect(verified.region).toBe(deps.env.REGION)
    expect(verified.expiresAt.getTime() - verified.issuedAt.getTime()).toBe(60_000)
  })

  test('carries the header and size the kit requires', async () => {
    const { issue } = await setup()
    const token = await issue()

    const header = decodeProtectedHeader(token)

    expect(header.typ).toBe('at+jwt')
    expect(header.alg).toBe('EdDSA')
    expect(typeof header.kid).toBe('string')
    expect(token.length).toBeLessThan(MAX_TOKEN_LENGTH)
  })

  test('is refused after it expires, for another audience, and for another issuer', async () => {
    const { deps, app, issue } = await setup()
    const keys = await createStaticKeySet(
      jwksSchema.parse(await (await app.request('/.well-known/jwks.json')).json())
    )
    const token = await issue()
    const verifier = (overrides: { issuer?: string; audience?: string } = {}) =>
      createTokenVerifier({
        issuer: publicUrl(deps.env),
        audience: deps.env.TOKEN_AUDIENCE,
        keys,
        clock: deps.clock,
        clockToleranceSeconds: 0,
        ...overrides,
      })

    await expect(verifier({ audience: 'someone-else' }).verify(token)).rejects.toMatchObject({
      reason: 'invalid',
    })
    await expect(verifier({ issuer: 'https://evil.example' }).verify(token)).rejects.toMatchObject({
      reason: 'invalid',
    })
    deps.clock.advance('61s')
    await expect(verifier().verify(token)).rejects.toMatchObject({ reason: 'expired' })
  })

  test('survives a rotation: a verifier that fetches the JWKS over HTTP accepts tokens of the new key', async () => {
    const { deps, tenant, app, issue } = await setup()
    await Jwks.ensureKeys(deps, tenant)
    const remote = createRemoteKeySet({
      url: `${publicUrl(deps.env)}/.well-known/jwks.json`,
      clock: deps.clock,
      fetch: ((input: Request | string | URL) =>
        app.request(new URL(String(input)).pathname)) as unknown as typeof fetch,
      sleep: async () => {},
    })
    const verifier = createTokenVerifier({
      issuer: publicUrl(deps.env),
      audience: deps.env.TOKEN_AUDIENCE,
      keys: remote,
      clock: deps.clock,
    })
    const before = await issue()
    await verifier.verify(before)

    // The new key has been listed since the first fetch, so ten minutes later it may sign.
    deps.clock.advance('10m')
    await Jwks.rotate(deps, tenant)
    const after = await issue()

    expect(decodeProtectedHeader(after).kid).not.toBe(decodeProtectedHeader(before).kid)
    expect((await verifier.verify(after)).userId).toBe(formatId('usr', userId))
  })

  test('a token signed by a key the JWKS never listed is refused', async () => {
    const { deps, issue } = await setup()
    const token = await issue()
    const stranger = await setup()
    const keys = await createStaticKeySet(
      jwksSchema.parse(await (await stranger.app.request('/.well-known/jwks.json')).json())
    )
    const verifier = createTokenVerifier({
      issuer: publicUrl(deps.env),
      audience: deps.env.TOKEN_AUDIENCE,
      keys,
      clock: deps.clock,
    })

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(TokenVerificationError)
  })
})
