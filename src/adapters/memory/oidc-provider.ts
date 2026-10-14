import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { createGoogleProvider } from '~/adapters/http/google'
import { sha256Base64Url } from '~/lib/crypto'
import type { Clock } from '~/ports/clock'
import type { OidcProvider } from '~/ports/oidc-provider'

/** The client id the fake provider issues tokens for. */
export const FAKE_CLIENT_ID = 'fake-client-id.apps.test'
/** The client secret the fake provider's token endpoint expects. */
export const FAKE_CLIENT_SECRET = 'fake-client-secret-not-a-secret'
/** The redirect URI the fake provider expects. */
export const FAKE_REDIRECT_URI = 'https://app.example.com/v1/client/google/callback'
/** The issuer of the fake provider. */
export const FAKE_ISSUER = 'https://fake-google.test'

/** What a Google account looks like to the fake provider. */
export type FakeAccount = {
  sub: string
  email: string
  name?: string
  givenName?: string
  familyName?: string
}

/** A way the fake provider's next ID token can be wrong. */
export type TokenFlaw =
  | 'bad_nonce'
  | 'bad_audience'
  | 'bad_issuer'
  | 'expired'
  | 'issued_in_future'
  | 'email_unverified'
  | 'wrong_algorithm'
  | 'wrong_signing_key'
  | 'no_subject'
  | 'no_email'
  | 'no_nonce'
  | 'extra_audience'
  | 'extra_audience_with_azp'

/** What the browser does at the fake Google: approves as an account, with an optional flaw. */
export type FakeVisit = { account: FakeAccount; flaw?: TokenFlaw } | { error: string }

/** The fake provider endpoints that can be made to fail. */
export type FakeEndpoint = 'discovery' | 'jwks' | 'token'

/** The in-memory provider for tests: the real HTTP adapter over a fake Google, with controls. */
export type MemoryOidcProvider = OidcProvider & {
  /** What the person does at Google; returns the query Google redirects back with. */
  visit: (authorizationUrl: string, visit: FakeVisit) => Promise<URLSearchParams>
  /** The authorization URLs asked for, in order. */
  readonly authorizationUrls: string[]
  /** Make the next `count` requests to an endpoint fail with a status, or as a network error. */
  failNext: (endpoint: FakeEndpoint, how: number | 'network', count?: number) => void
  /** Make the next request to an endpoint take longer than the adapter's bound. */
  stallNext: (endpoint: FakeEndpoint) => void
  /** Switch to a new signing key (the old one stops being published). */
  rotateKey: () => Promise<void>
  /** How many requests each endpoint has received. */
  readonly requests: Record<FakeEndpoint, number>
  /** The token requests' form fields, in order (for asserting what the adapter sent). */
  readonly tokenRequests: Record<string, string>[]
}

type Pending = {
  account: FakeAccount
  flaw: TokenFlaw | undefined
  nonce: string
  challenge: string
  used: boolean
}

type Signing = { kid: string; privateKey: CryptoKey; jwk: JWK }

async function newSigning(kid: string): Promise<Signing> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } }
}

/**
 * Builds the memory provider: a fake Google (discovery, signing keys, a token endpoint that
 * checks the PKCE verifier, client and redirect) served to the real HTTP adapter through an
 * injected `fetch`, so tests exercise the adapter's verification, retries and caching.
 */
export function createMemoryOidcProvider(clock: Clock): MemoryOidcProvider {
  // The keys are made on first use, so building the test container stays synchronous and cheap.
  let keys: Promise<{ signing: Signing; wrongKey: Signing }> | undefined
  const current = () => {
    keys ??= Promise.all([newSigning('fake-key-1'), newSigning('fake-key-1')]).then(
      ([signing, wrongKey]) => ({ signing, wrongKey })
    )
    return keys
  }
  let rotations = 1
  const codes = new Map<string, Pending>()
  const failures: Record<FakeEndpoint, (number | 'network')[]> = {
    discovery: [],
    jwks: [],
    token: [],
  }
  const stalls = new Set<FakeEndpoint>()
  const requests: Record<FakeEndpoint, number> = { discovery: 0, jwks: 0, token: 0 }
  const tokenRequests: Record<string, string>[] = []
  const authorizationUrls: string[] = []

  async function issue(pending: Pending): Promise<string> {
    const { account, flaw } = pending
    const now = Math.floor(clock.now().getTime() / 1000)
    const claims: Record<string, unknown> = {
      email: account.email,
      email_verified: flaw !== 'email_unverified',
      nonce: flaw === 'bad_nonce' ? `${pending.nonce}x` : pending.nonce,
      ...(account.name === undefined ? {} : { name: account.name }),
      ...(account.givenName === undefined ? {} : { given_name: account.givenName }),
      ...(account.familyName === undefined ? {} : { family_name: account.familyName }),
    }
    if (flaw === 'no_email') {
      claims.email = undefined
    }
    if (flaw === 'extra_audience_with_azp') {
      claims.azp = FAKE_CLIENT_ID
    }
    if (flaw === 'no_nonce') {
      claims.nonce = undefined
    }
    const { signing, wrongKey } = await current()
    const key = flaw === 'wrong_signing_key' ? wrongKey : signing
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: flaw === 'wrong_algorithm' ? 'RS512' : 'RS256', kid: key.kid })
      .setIssuer(flaw === 'bad_issuer' ? 'https://evil.test' : FAKE_ISSUER)
      .setAudience(
        flaw === 'bad_audience'
          ? 'another-client'
          : flaw === 'extra_audience' || flaw === 'extra_audience_with_azp'
            ? [FAKE_CLIENT_ID, 'another-client']
            : FAKE_CLIENT_ID
      )
      .setIssuedAt(flaw === 'expired' ? now - 7200 : flaw === 'issued_in_future' ? now + 3600 : now)
      .setExpirationTime(
        flaw === 'expired' ? now - 3600 : flaw === 'issued_in_future' ? now + 7200 : now + 3600
      )
    if (flaw !== 'no_subject') {
      jwt = jwt.setSubject(account.sub)
    }
    return jwt.sign(key.privateKey)
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const endpoint: FakeEndpoint | undefined =
      url.pathname === '/.well-known/openid-configuration'
        ? 'discovery'
        : url.pathname === '/jwks'
          ? 'jwks'
          : url.pathname === '/token'
            ? 'token'
            : undefined
    if (endpoint === undefined) {
      return json({ error: 'not_found' }, 404)
    }
    requests[endpoint] += 1
    if (stalls.delete(endpoint)) {
      await new Promise<never>((_, reject) =>
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      )
    }
    const failure = failures[endpoint].shift()
    if (failure === 'network') {
      throw new TypeError('fetch failed')
    }
    if (failure !== undefined) {
      return json({ error: 'server_error' }, failure)
    }
    if (endpoint === 'discovery') {
      return json({
        issuer: FAKE_ISSUER,
        authorization_endpoint: `${FAKE_ISSUER}/authorize`,
        token_endpoint: `${FAKE_ISSUER}/token`,
        jwks_uri: `${FAKE_ISSUER}/jwks`,
      })
    }
    if (endpoint === 'jwks') {
      return json({ keys: [(await current()).signing.jwk] })
    }
    const form = Object.fromEntries(new URLSearchParams(await request.text()))
    tokenRequests.push(form)
    const pending = codes.get(form.code ?? '')
    if (
      form.client_id !== FAKE_CLIENT_ID ||
      form.client_secret !== FAKE_CLIENT_SECRET ||
      form.redirect_uri !== FAKE_REDIRECT_URI ||
      form.grant_type !== 'authorization_code' ||
      !pending ||
      pending.used ||
      sha256Base64Url(form.code_verifier ?? '') !== pending.challenge
    ) {
      if (pending) {
        pending.used = true
      }
      return json({ error: 'invalid_grant' }, 400)
    }
    pending.used = true
    return json({ id_token: await issue(pending), token_type: 'Bearer', expires_in: 3600 })
  }

  const provider = createGoogleProvider({
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    redirectUri: FAKE_REDIRECT_URI,
    issuer: FAKE_ISSUER,
    clock,
    logger: { warn: () => {} },
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handle(
        new Request(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          init
        )
      )) as typeof globalThis.fetch,
    sleep: async () => {},
    random: () => 0,
    timeoutMs: 200,
  })

  return {
    ...provider,
    authorizationUrls,
    requests,
    tokenRequests,
    async authorizationUrl(input) {
      const url = await provider.authorizationUrl(input)
      authorizationUrls.push(url)
      return url
    },
    async visit(authorizationUrl, visit) {
      const url = new URL(authorizationUrl)
      const state = url.searchParams.get('state') ?? ''
      if ('error' in visit) {
        return new URLSearchParams({ error: visit.error, state })
      }
      const code = `fake-code-${crypto.randomUUID()}`
      codes.set(code, {
        account: visit.account,
        flaw: visit.flaw,
        nonce: url.searchParams.get('nonce') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        used: false,
      })
      return new URLSearchParams({ code, state })
    },
    failNext(endpoint, how, count = 1) {
      for (let n = 0; n < count; n += 1) {
        failures[endpoint].push(how)
      }
    },
    stallNext(endpoint) {
      stalls.add(endpoint)
    },
    async rotateKey() {
      rotations += 1
      const next = await newSigning(`fake-key-${rotations}`)
      const wrong = await newSigning(next.kid)
      keys = Promise.resolve({ signing: next, wrongKey: wrong })
    },
  }
}
