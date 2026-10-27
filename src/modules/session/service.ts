import { decodeJwt } from 'jose'
import { AUTH_ERRORS, ERRORS, formatId, type Role } from 'tula-closeline-contract'
import { REFRESH_SEALED_NEXT_TOKEN_MAX_BYTES } from 'tula-closeline-db/schema'
import { createTokenVerifier, TokenVerificationError, type VerifiedToken } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { publicUrl } from '~/env'
import { fail } from '~/errors'
import { randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { durationToMs } from '~/lib/duration'
import * as Jwks from '~/modules/jwks/service'
import type * as Tokens from '~/modules/token/service'
import type { Tenant } from '~/ports/fixed-project'
import type { Membership as MembershipClaim } from '~/ports/membership'
import {
  isActive,
  type RefreshTokenRecord,
  type SessionClient,
  type SessionRecord,
} from '~/ports/session-store'

/** Prefix of a refresh token, so it can be recognised in a log scan or a secret scanner. */
export const REFRESH_TOKEN_PREFIX = 'tula_rt_'
/** A session ends after this long without a refresh. */
export const IDLE_TIMEOUT = '7d'
/** A session ends this long after sign-in, whatever its activity. */
export const ABSOLUTE_TIMEOUT = '30d'
/** A spent refresh token is answered with the same next token for this long (a lost response). */
export const REUSE_GRACE_MS = 10_000
/** The longest refresh token accepted, before any lookup. */
export const MAX_REFRESH_TOKEN_LENGTH = 256

/** What the session service needs from the container. */
export type SessionDeps = Pick<
  Container,
  | 'env'
  | 'clock'
  | 'ids'
  | 'sessions'
  | 'users'
  | 'membership'
  | 'signingKeys'
  | 'secretBox'
  | 'logger'
>

/** A session as the client receives it right after sign-in or refresh. */
export type IssuedSession = {
  sessionId: string
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  organization: { id: string; role: Role }
  /** When the session ends whatever its activity; the refresh cookie's lifetime. Not a body field. */
  absoluteExpiresAt: Date
}

/** The body a client that holds its refresh token receives: exactly the fields it always has. */
export function bodyOf(session: IssuedSession) {
  return {
    sessionId: session.sessionId,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshToken: session.refreshToken,
    organization: session.organization,
  }
}

/** The body the `browser` client type receives: no refresh token (it travels in a cookie). */
export function browserBodyOf(session: IssuedSession) {
  return {
    sessionId: session.sessionId,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    organization: session.organization,
  }
}

/** Purpose label of the key that seals a refresh token's successor on the spent row. */
export const SEAL_PURPOSE = 'refresh-next-tokens'

/** A new refresh token: 32 random bytes, base64url, behind the prefix (ADR 0026). */
export function newRefreshToken(): string {
  return `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`
}

/** Seals `next` for the spent row `parentId` (AES-256-GCM, the row id as associated data). */
export async function sealNext(
  deps: Pick<Container, 'secretBox'>,
  parentId: string,
  next: string
): Promise<Uint8Array> {
  const sealed = Buffer.from(
    await deps.secretBox.seal(SEAL_PURPOSE, new TextEncoder().encode(next), parentId)
  )
  if (sealed.byteLength > REFRESH_SEALED_NEXT_TOKEN_MAX_BYTES) {
    throw new Error('sealed refresh token exceeds the column limit')
  }
  return sealed
}

/**
 * Opens the next token sealed on a spent row. `null` when there is none, it does not open (wrong
 * key, row or altered bytes) or it is not the stored child's token: all read as reuse.
 */
export async function unsealNext(
  deps: Pick<Container, 'secretBox'>,
  spent: RefreshTokenRecord,
  child: RefreshTokenRecord
): Promise<string | null> {
  if (spent.sealedNextToken === null) {
    return null
  }
  try {
    const plain = await deps.secretBox.open(
      SEAL_PURPOSE,
      Buffer.from(spent.sealedNextToken).toString('utf8'),
      spent.id
    )
    const next = new TextDecoder('utf-8', { fatal: true }).decode(plain)
    return timingSafeEqual(sha256Hex(next), child.tokenHash) ? next : null
  } catch {
    return null
  }
}

/** The idle expiry after activity at `now`, never past the absolute one. */
export function idleExpiry(now: Date, absoluteExpiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + durationToMs(IDLE_TIMEOUT), absoluteExpiresAt.getTime()))
}

/** The response for a session with fresh tokens. */
export function issued(
  sessionId: string,
  access: { accessToken: string; accessTokenExpiresAt: string },
  refreshToken: string,
  membership: MembershipClaim,
  absoluteExpiresAt: Date
): IssuedSession {
  return {
    sessionId,
    ...access,
    refreshToken,
    organization: { id: membership.organizationId, role: membership.role },
    absoluteExpiresAt,
  }
}

/**
 * Starts a session for a user who has just proved who they are, and issues its first tokens.
 *
 * The caller loads the signing key first (see {@link Tokens.signer}), so a missing key cannot
 * leave a stored session whose tokens were never delivered.
 */
export async function create(
  deps: SessionDeps,
  tenant: Tenant,
  input: {
    userId: string
    client: SessionClient
    authMethods: readonly string[]
    membership: MembershipClaim
    sign: Tokens.Signer
  }
): Promise<IssuedSession> {
  const now = deps.clock.now()
  const absoluteExpiresAt = new Date(now.getTime() + durationToMs(ABSOLUTE_TIMEOUT))
  const idleExpiresAt = idleExpiry(now, absoluteExpiresAt)
  const sessionId = deps.ids.next()
  const refreshToken = newRefreshToken()
  const access = await input.sign(
    { id: sessionId, userId: input.userId, authenticatedAt: now, authMethods: input.authMethods },
    input.membership,
    now
  )
  await deps.sessions.create(
    {
      id: sessionId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      userId: input.userId,
      client: input.client,
      lastActiveAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
      factorVerifiedAt: now,
      authMethods: [...input.authMethods],
      createdAt: now,
    },
    {
      id: deps.ids.next(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      sessionId,
      tokenHash: sha256Hex(refreshToken),
      parentId: null,
      expiresAt: idleExpiresAt,
      createdAt: now,
    }
  )
  return issued(sessionId, access, refreshToken, input.membership, absoluteExpiresAt)
}

/** Refuses a session that was revoked or has timed out. */
export function rejectEnded(session: SessionRecord, now: Date): void {
  if (session.revokedAt !== null) {
    throw fail(
      session.revokeReason === 'reuse_detected'
        ? AUTH_ERRORS['session.reuse_detected']
        : AUTH_ERRORS['session.revoked']
    )
  }
  if (!isActive(session, now)) {
    throw fail(AUTH_ERRORS['session.expired'])
  }
}

/** The caller of an authenticated request: the verified token and its live session. */
export type Caller = { token: VerifiedToken; session: SessionRecord }

/**
 * Checks an access token as any other service would (the kit verifier over this service's own
 * JWKS), then that its session has not ended: elsewhere a token outlives a sign-out by at most
 * its 60 seconds, here never.
 *
 * @throws AppError `auth.unauthenticated`, `auth.token_expired`, `auth.token_invalid`,
 *   `auth.unavailable`, `session.revoked`, `session.expired`.
 */
export async function authenticate(
  deps: SessionDeps,
  tenant: Tenant,
  authorization: string | undefined
): Promise<Caller> {
  const match = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization) : null
  if (!match?.[1]) {
    throw fail(ERRORS['auth.unauthenticated'])
  }
  const accessToken = match[1]
  const verifier = createTokenVerifier({
    issuer: publicUrl(deps.env),
    audience: deps.env.TOKEN_AUDIENCE,
    keys: await Jwks.verificationKeySet(deps, tenant),
    clock: deps.clock,
  })
  let token: VerifiedToken
  try {
    const identity = await verifier.verify(accessToken)
    if (identity.actor !== 'member') {
      // A session belongs to a person: an API key's token never authenticates one.
      throw fail(ERRORS['auth.token_invalid'])
    }
    token = identity
  } catch (error) {
    if (error instanceof TokenVerificationError) {
      throw fail(
        error.reason === 'expired'
          ? ERRORS['auth.token_expired']
          : error.reason === 'unavailable'
            ? ERRORS['auth.unavailable']
            : ERRORS['auth.token_invalid']
      )
    }
    throw error
  }
  const sid = decodeJwt(accessToken).sid
  const session =
    typeof sid === 'string' && /^[0-9a-f-]{36}$/.test(sid)
      ? await deps.sessions.findById(tenant.environmentId, sid)
      : null
  if (!session || formatId('usr', session.userId) !== token.userId) {
    throw fail(ERRORS['auth.token_invalid'])
  }
  if (session.revokedAt !== null) {
    throw fail(AUTH_ERRORS['session.revoked'])
  }
  rejectEnded(session, deps.clock.now())
  return { token, session }
}
