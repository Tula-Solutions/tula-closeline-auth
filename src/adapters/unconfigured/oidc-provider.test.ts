import { expect, test } from 'bun:test'
import { createOidcProvider } from '~/container'
import { loadEnv } from '~/env'
import { OidcFailure } from '~/ports/oidc-provider'
import { createUnconfiguredOidcProvider } from './oidc-provider'

const clock = { now: () => new Date() }
const logger = { warn: () => {} }

test('the unconfigured provider is off and every call answers disabled', async () => {
  const provider = createUnconfiguredOidcProvider()

  expect(provider.enabled).toBe(false)
  for (const call of [
    () => provider.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    () => provider.exchangeCode({ code: 'c', codeVerifier: 'v' }),
    () => provider.verifyIdToken('t'),
  ]) {
    await expect(call()).rejects.toMatchObject({ reason: 'disabled' })
    await expect(call()).rejects.toBeInstanceOf(OidcFailure)
  }
})

test('with no GOOGLE_ setting the container boots with Google off', () => {
  const env = loadEnv({ ENVIRONMENT: 'local', REGION: 'us' })
  expect(createOidcProvider(env, clock, logger).enabled).toBe(false)
})

test('with the three GOOGLE_ settings the HTTP provider is chosen', () => {
  const env = loadEnv({
    ENVIRONMENT: 'local',
    REGION: 'us',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3002/v1/client/google/callback',
  })
  expect(createOidcProvider(env, clock, logger).enabled).toBe(true)
})
