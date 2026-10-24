import { SignJWT } from 'jose'
import { type ApiKeyScope, formatId } from 'tula-closeline-contract'
import { API_KEY_ACTOR, MAX_TOKEN_LENGTH } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { publicUrl } from '~/env'
import { ACCESS_TOKEN_ALGORITHM } from '~/modules/jwks/schema'
import * as Jwks from '~/modules/jwks/service'
import type { Tenant } from '~/ports/fixed-project'
import type { ApiKeyVerification, Membership } from '~/ports/membership'

/** How long an access token is valid, in seconds (the source's `web` and `mobile` profiles). */
export const ACCESS_TOKEN_TTL_SECONDS = 60

/** How long an API key's access token is valid, in seconds (ADR 0023): 10 minutes, no refresh. */
export const API_KEY_TOKEN_TTL_SECONDS = 600

/** The header `typ` of an access token (RFC 9068); the kit's verifier requires exactly this. */
export const ACCESS_TOKEN_TYPE = 'at+jwt'

/** What token signing needs from the container. */
export type TokenDeps = Pick<Container, 'env' | 'clock' | 'signingKeys' | 'secretBox' | 'ids'>

/** The session facts a token carries beyond identity. */
export type TokenSession = {
  id: string
  userId: string
  /** When the user last proved who they are; fixed for the session's life. */
  authenticatedAt: Date
  /** What they proved, e.g. `['pwd']`. */
  authMethods: readonly string[]
}

/** Prepared once: loads the signing key so a failure here happens before anything is stored. */
export type Signer = (
  session: TokenSession,
  membership: Membership,
  now: Date
) => Promise<{
  accessToken: string
  accessTokenExpiresAt: string
}>

/**
 * Load the active signing key and return a function that signs access tokens with it.
 *
 * The key is loaded **before** a session is stored or a refresh token rotated: if loading failed
 * after the write, the client would be left without the token the database says it has.
 */
export async function signer(deps: TokenDeps, tenant: Tenant): Promise<Signer> {
  const { kid, privateKey } = await Jwks.activeSigningKey(deps, tenant)
  const issuer = publicUrl(deps.env)
  return async (session, membership, now) => {
    const iat = Math.floor(now.getTime() / 1000)
    const exp = iat + ACCESS_TOKEN_TTL_SECONDS
    const accessToken = await new SignJWT({
      org: membership.organizationId,
      role: membership.role,
      region: deps.env.REGION,
      sid: session.id,
      auth_time: Math.floor(session.authenticatedAt.getTime() / 1000),
      amr: [...session.authMethods],
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid, typ: ACCESS_TOKEN_TYPE })
      .setIssuer(issuer)
      .setSubject(formatId('usr', session.userId))
      .setAudience(deps.env.TOKEN_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(privateKey)
    if (accessToken.length >= MAX_TOKEN_LENGTH) {
      throw new Error('the access token would be too long for the verifier')
    }
    return { accessToken, accessTokenExpiresAt: new Date(exp * 1000).toISOString() }
  }
}

/** Signs the access token of an API key; prepared by {@link apiKeySigner}. */
export type ApiKeySigner = (
  key: Pick<ApiKeyVerification, 'apiKeyId' | 'organizationId'> & {
    scopes: readonly ApiKeyScope[]
  },
  now: Date
) => Promise<{ accessToken: string; accessTokenExpiresAt: string }>

/**
 * Load the active signing key and return a function that signs the token of an API key (ADR
 * 0023): `act: 'api_key'`, `sub` the key id, the Organization, Region and scopes, and no `role`,
 * no session and no Membership. It lives {@link API_KEY_TOKEN_TTL_SECONDS}.
 */
export async function apiKeySigner(deps: TokenDeps, tenant: Tenant): Promise<ApiKeySigner> {
  const { kid, privateKey } = await Jwks.activeSigningKey(deps, tenant)
  const issuer = publicUrl(deps.env)
  return async (key, now) => {
    const iat = Math.floor(now.getTime() / 1000)
    const exp = iat + API_KEY_TOKEN_TTL_SECONDS
    const accessToken = await new SignJWT({
      act: API_KEY_ACTOR,
      org: key.organizationId,
      region: deps.env.REGION,
      scp: [...key.scopes],
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid, typ: ACCESS_TOKEN_TYPE })
      .setIssuer(issuer)
      .setSubject(key.apiKeyId)
      .setAudience(deps.env.TOKEN_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(privateKey)
    if (accessToken.length >= MAX_TOKEN_LENGTH) {
      throw new Error('the access token would be too long for the verifier')
    }
    return { accessToken, accessTokenExpiresAt: new Date(exp * 1000).toISOString() }
  }
}
