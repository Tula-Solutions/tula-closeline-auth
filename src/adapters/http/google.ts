import { createLocalJWKSet, decodeProtectedHeader, type JWK, jwtVerify } from 'jose'
import { authorizationUrlSchema } from 'tula-closeline-contract'
import type { Logger } from 'tula-closeline-kit'
import { z } from 'zod'
import type { Clock } from '~/ports/clock'
import { type GoogleProfile, OidcFailure, type OidcProvider } from '~/ports/oidc-provider'

/** The longest one call to the provider may take. */
export const GOOGLE_TIMEOUT_MS = 5_000
/** The most retries of a call that failed with a network error or a 5xx (so up to 3 tries). */
export const GOOGLE_MAX_RETRIES = 2
/** How far a token's `exp` and `iat` may be out, in seconds. */
export const GOOGLE_CLOCK_SKEW_SECONDS = 60
/** How long the discovery document is kept. */
export const DISCOVERY_TTL_MS = 3_600_000
/** How long the signing keys are kept; an unknown key id refetches sooner, at most this often. */
export const JWKS_TTL_MS = 3_600_000
/** The longest a cached signing key is used when the provider cannot be reached. */
export const JWKS_MAX_STALE_MS = 86_400_000
/** The least time between two refetches of the keys caused by an unknown key id. */
export const JWKS_REFETCH_COOLDOWN_MS = 30_000
/** The largest provider response read. */
const MAX_RESPONSE_BYTES = 1_048_576

/** The issuers an ID token from Google may carry. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** Options for {@link createGoogleProvider}. */
export type GoogleProviderOptions = {
  clientId: string
  clientSecret: string
  redirectUri: string
  /** `https://accounts.google.com`, or the local fake provider. */
  issuer: string
  clock: Clock
  /** Where a failure is noted: a fixed word and a status, never a token, code or secret. */
  logger: Pick<Logger, 'warn'>
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Per-call bound; defaults to {@link GOOGLE_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Pause between tries; defaults to a real wait. */
  sleep?: (ms: number) => Promise<void>
  /** Source of jitter in [0, 1); defaults to `Math.random`. */
  random?: () => number
}

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
})
type Discovery = z.infer<typeof discoverySchema>

const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).max(50) })
const tokenResponseSchema = z.object({ id_token: z.string().min(1).max(8192) })

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().min(1).max(320),
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  nonce: z.string().min(1).max(512),
  name: z.string().max(400).optional(),
  given_name: z.string().max(200).optional(),
  family_name: z.string().max(200).optional(),
  iat: z.number(),
})

/** Whether a response came back at all but not in the success range. */
type Answer = { status: number; text: string }

/**
 * The OpenID Connect provider over HTTP, for Google (or the local fake provider). Every call has
 * a 5 s bound and at most two jittered retries, on a network error or a 5xx only; the code
 * exchange is retried only when no response came back at all. Discovery and the signing keys are
 * cached; an unknown key id refetches the keys (at most once per cooldown).
 */
export function createGoogleProvider(options: GoogleProviderOptions): OidcProvider {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? GOOGLE_TIMEOUT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random
  const issuers = options.issuer === GOOGLE_ISSUERS[0] ? GOOGLE_ISSUERS : [options.issuer]
  const loopbackIssuer = options.issuer.startsWith('http://')

  /** One bounded call; `unavailable` on a network error, timeout or oversized body. */
  async function once(url: string, init: RequestInit): Promise<Answer | 'network' | 'oversize'> {
    try {
      const response = await doFetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {})
        return 'oversize'
      }
      const text = await readCapped(response)
      return text === undefined ? 'oversize' : { status: response.status, text }
    } catch {
      return 'network'
    }
  }

  /**
   * Calls with the retry rule. `retryServerErrors` is false for the code exchange: once Google
   * has answered, the code may be spent, so the answer is final.
   */
  async function call(
    what: string,
    url: string,
    init: RequestInit,
    retryServerErrors: boolean
  ): Promise<Answer> {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await once(url, init)
      if (answer === 'oversize') {
        // A body past the cap is not a transient fault: reading it again would cost the same.
        options.logger.warn('the OpenID provider answered with too much data', { call: what })
        throw new OidcFailure('unavailable', what)
      }
      const failed = answer === 'network' || answer.status >= 500
      if (!failed) {
        return answer
      }
      const retryable = answer === 'network' || retryServerErrors
      if (!retryable || attempt >= GOOGLE_MAX_RETRIES) {
        options.logger.warn('the OpenID provider is unavailable', {
          call: what,
          status: answer === 'network' ? 'network' : answer.status,
        })
        throw new OidcFailure('unavailable', what)
      }
      await sleep(Math.round(100 * 2 ** attempt * (1 + random())))
    }
  }

  const endpointOk = (value: string): boolean =>
    authorizationUrlSchema.safeParse(value).success &&
    (value.startsWith('https://') || loopbackIssuer)

  let discovery: { value: Discovery; at: number } | undefined
  let discovering: Promise<Discovery> | undefined
  async function discover(): Promise<Discovery> {
    const now = options.clock.now().getTime()
    if (discovery && now - discovery.at < DISCOVERY_TTL_MS) {
      return discovery.value
    }
    discovering ??= (async () => {
      const answer = await call(
        'discovery',
        `${options.issuer}/.well-known/openid-configuration`,
        { headers: { accept: 'application/json' } },
        true
      )
      const parsed = answer.status === 200 ? parseJson(answer.text, discoverySchema) : undefined
      if (
        !parsed ||
        parsed.issuer.replace(/\/+$/, '') !== options.issuer ||
        !endpointOk(parsed.authorization_endpoint) ||
        !endpointOk(parsed.token_endpoint) ||
        !endpointOk(parsed.jwks_uri)
      ) {
        options.logger.warn('the OpenID discovery document is unusable', { status: answer.status })
        throw new OidcFailure('unavailable', 'discovery')
      }
      discovery = { value: parsed, at: options.clock.now().getTime() }
      return parsed
    })().finally(() => {
      discovering = undefined
    })
    return discovering
  }

  let keys: { value: JWK[]; at: number } | undefined
  let fetchingKeys: Promise<JWK[]> | undefined
  async function fetchKeys(): Promise<JWK[]> {
    fetchingKeys ??= (async () => {
      const { jwks_uri } = await discover()
      const answer = await call('jwks', jwks_uri, { headers: { accept: 'application/json' } }, true)
      const parsed = answer.status === 200 ? parseJson(answer.text, jwksSchema) : undefined
      if (!parsed) {
        options.logger.warn('the OpenID signing keys are unusable', { status: answer.status })
        throw new OidcFailure('unavailable', 'jwks')
      }
      keys = { value: parsed.keys as JWK[], at: options.clock.now().getTime() }
      return keys.value
    })().finally(() => {
      fetchingKeys = undefined
    })
    return fetchingKeys
  }

  /** When the last refresh of the keys failed; no refetch is tried for the cooldown after it. */
  let failedAt: number | undefined

  /**
   * The keys that can verify a token naming `kid`. Fresh keys are used as they are. Otherwise they
   * are refetched, but not within the cooldown of the last fetch or of the last failure, so
   * forged key ids or an outage cannot multiply calls to the provider. When the provider cannot
   * be reached and the cache holds the very key the token names, that key is used for at most
   * {@link JWKS_MAX_STALE_MS}; a key the cache has never seen stays unavailable.
   */
  async function keySet(kid: string): Promise<JWK[]> {
    const now = options.clock.now().getTime()
    const fresh = keys !== undefined && now - keys.at < JWKS_TTL_MS
    if (keys && fresh && keys.value.some((key) => key.kid === kid)) {
      return keys.value
    }
    if (keys && fresh && now - keys.at < JWKS_REFETCH_COOLDOWN_MS) {
      return keys.value
    }
    const usableStale = (): JWK[] | undefined =>
      keys !== undefined &&
      now - keys.at <= JWKS_MAX_STALE_MS &&
      keys.value.some((key) => key.kid === kid)
        ? keys.value
        : undefined
    if (failedAt !== undefined && now - failedAt < JWKS_REFETCH_COOLDOWN_MS) {
      const stale = usableStale()
      if (stale) {
        return stale
      }
      throw new OidcFailure('unavailable', 'jwks')
    }
    try {
      const fetched = await fetchKeys()
      failedAt = undefined
      return fetched
    } catch (error) {
      if (!(error instanceof OidcFailure) || error.reason !== 'unavailable') {
        throw error
      }
      failedAt = now
      const stale = usableStale()
      if (stale) {
        options.logger.warn('the OpenID signing keys could not be refreshed; using the cached key')
        return stale
      }
      throw error
    }
  }

  return {
    enabled: true,

    async authorizationUrl({ state, nonce, codeChallenge }) {
      const { authorization_endpoint } = await discover()
      const url = new URL(authorization_endpoint)
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', options.redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', 'openid email profile')
      url.searchParams.set('state', state)
      url.searchParams.set('nonce', nonce)
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('prompt', 'select_account')
      return url.toString()
    },

    async exchangeCode({ code, codeVerifier }) {
      const { token_endpoint } = await discover()
      const answer = await call(
        'token',
        token_endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: options.redirectUri,
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code_verifier: codeVerifier,
          }).toString(),
        },
        false
      )
      if (answer.status === 200) {
        const parsed = parseJson(answer.text, tokenResponseSchema)
        if (parsed) {
          return { idToken: parsed.id_token }
        }
        options.logger.warn('the OpenID token response is unusable', { status: answer.status })
        throw new OidcFailure('rejected', 'token response')
      }
      if (answer.status >= 500) {
        // Google answered: the code may be spent, so it is not retried (see `call`).
        throw new OidcFailure('unavailable', 'token')
      }
      options.logger.warn('the OpenID provider refused the code', {
        status: answer.status,
        error: oauthErrorName(answer.text),
      })
      throw new OidcFailure('rejected', 'token')
    },

    async verifyIdToken(idToken) {
      let kid: string | undefined
      try {
        const header = decodeProtectedHeader(idToken)
        if (header.alg !== 'RS256') {
          throw new OidcFailure('invalid_token', 'alg')
        }
        kid = header.kid
      } catch (error) {
        throw error instanceof OidcFailure ? error : new OidcFailure('invalid_token', 'header')
      }
      if (kid === undefined) {
        throw new OidcFailure('invalid_token', 'kid')
      }
      const set = createLocalJWKSet({ keys: await keySet(kid) })
      const now = options.clock.now()
      let payload: Record<string, unknown>
      try {
        const verified = await jwtVerify(idToken, set, {
          algorithms: ['RS256'],
          issuer: issuers,
          audience: options.clientId,
          clockTolerance: GOOGLE_CLOCK_SKEW_SECONDS,
          currentDate: now,
          requiredClaims: ['exp', 'iat', 'sub'],
        })
        payload = verified.payload
      } catch {
        throw new OidcFailure('invalid_token', 'signature or claims')
      }
      const claims = claimsSchema.safeParse(payload)
      if (!claims.success) {
        throw new OidcFailure('invalid_token', 'claims')
      }
      const c = claims.data
      // OpenID Connect Core 3.1.3.7: an authorized party that is not us is refused whatever the
      // shape of `aud`, and with several audiences it must be present and be us.
      const severalAudiences = Array.isArray(payload.aud) && payload.aud.length > 1
      if (
        (payload.azp !== undefined && payload.azp !== options.clientId) ||
        (severalAudiences && payload.azp !== options.clientId)
      ) {
        throw new OidcFailure('invalid_token', 'azp')
      }
      if (c.iat > now.getTime() / 1000 + GOOGLE_CLOCK_SKEW_SECONDS) {
        throw new OidcFailure('invalid_token', 'iat')
      }
      if (c.email_verified !== true && c.email_verified !== 'true') {
        throw new OidcFailure('email_unverified')
      }
      return {
        subject: c.sub,
        email: c.email,
        name: c.name ?? null,
        givenName: c.given_name ?? null,
        familyName: c.family_name ?? null,
        nonce: c.nonce,
      } satisfies GoogleProfile
    },
  }
}

/**
 * The body as text, read through a stream and cancelled as soon as it passes the cap, so a huge
 * or endless body is never held; `undefined` when it was too large.
 */
async function readCapped(response: Response): Promise<string | undefined> {
  if (response.body === null) {
    return ''
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parses JSON text against a schema; `undefined` when it is not JSON or does not match. */
function parseJson<T extends z.ZodType>(text: string, schema: T): z.infer<T> | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** The OAuth `error` word of a refusal (`invalid_grant`), or `unknown`; safe to log. */
function oauthErrorName(text: string): string {
  const parsed = parseJson(text, z.object({ error: z.string().regex(/^[a-z_]{1,40}$/) }))
  return parsed?.error ?? 'unknown'
}
