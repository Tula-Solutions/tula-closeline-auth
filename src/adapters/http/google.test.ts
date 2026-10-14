import { describe, expect, test } from 'bun:test'
import { createFixedClock } from 'tula-closeline-kit'
import { createMemoryOidcProvider, type TokenFlaw } from '~/adapters/memory/oidc-provider'
import { createGoogleProvider } from './google'

const ACCOUNT = { sub: 'sub-1', email: 'maya@northline.app' }

/** Runs the flow against the fake Google up to the ID token and verifies it. */
async function signIn(
  provider: ReturnType<typeof createMemoryOidcProvider>,
  flaw?: TokenFlaw
): Promise<unknown> {
  const url = await provider.authorizationUrl({
    state: 's',
    nonce: 'n',
    codeChallenge: new Bun.CryptoHasher('sha256').update('verifier').digest('base64url'),
  })
  const query = await provider.visit(url, { account: ACCOUNT, ...(flaw ? { flaw } : {}) })
  const { idToken } = await provider.exchangeCode({
    code: query.get('code') ?? '',
    codeVerifier: 'verifier',
  })
  return provider.verifyIdToken(idToken)
}

describe('the audience', () => {
  test('a token with several audiences needs azp to be the client id', async () => {
    const provider = createMemoryOidcProvider(createFixedClock('2026-01-01T00:00:00Z'))
    await expect(signIn(provider, 'extra_audience')).rejects.toMatchObject({
      reason: 'invalid_token',
    })
  })

  test('a token with several audiences and azp equal to the client id is accepted', async () => {
    const provider = createMemoryOidcProvider(createFixedClock('2026-01-01T00:00:00Z'))
    await expect(signIn(provider, 'extra_audience_with_azp')).resolves.toMatchObject({
      subject: 'sub-1',
    })
  })
})

describe('the signing keys', () => {
  test('a stale cached key still verifies when the refetch fails', async () => {
    const clock = createFixedClock('2026-01-01T00:00:00Z')
    const provider = createMemoryOidcProvider(clock)
    await signIn(provider)

    clock.advance('2h')
    provider.failNext('jwks', 503, 3)

    await expect(signIn(provider)).resolves.toMatchObject({ subject: 'sub-1' })
    expect(provider.requests.jwks).toBe(4)
  })

  test('an unknown key id is refused when the refetch fails', async () => {
    const clock = createFixedClock('2026-01-01T00:00:00Z')
    const provider = createMemoryOidcProvider(clock)
    await signIn(provider)
    await provider.rotateKey()
    clock.advance('2h')
    provider.failNext('jwks', 503, 3)

    await expect(signIn(provider)).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('the response size cap', () => {
  test('a chunked 5 MiB body is cut off once the 1 MiB cap is passed, and not retried', async () => {
    let pulled = 0
    let cancelled = false
    let calls = 0
    const chunk = new Uint8Array(64 * 1024).fill(97)
    const provider = createGoogleProvider({
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'https://app.example.com/v1/client/google/callback',
      issuer: 'https://fake-google.test',
      clock: createFixedClock('2026-01-01T00:00:00Z'),
      logger: { warn: () => {} },
      sleep: async () => {},
      fetch: (async () => {
        calls += 1
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= 5 * 1024 * 1024) {
                controller.close()
                return
              }
              pulled += chunk.byteLength
              controller.enqueue(chunk)
            },
            cancel() {
              cancelled = true
            },
          })
        )
      }) as unknown as typeof globalThis.fetch,
    })

    await expect(
      provider.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })
    ).rejects.toMatchObject({ reason: 'unavailable' })

    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(2 * 1024 * 1024)
    expect(calls).toBe(1)
  })
})
