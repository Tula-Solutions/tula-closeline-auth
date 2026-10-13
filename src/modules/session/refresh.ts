import { formatId, type UserId } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { AUTH_ERRORS, fail } from '~/errors'
import { sha256Hex } from '~/lib/crypto'
import * as Membership from '~/modules/membership/service'
import * as Tokens from '~/modules/token/service'
import type { Tenant } from '~/ports/fixed-project'
import type { SessionPosition, SessionRecord } from '~/ports/session-store'
import {
  deriveToken,
  type IssuedSession,
  idleExpiry,
  issued,
  MAX_REFRESH_TOKEN_LENGTH,
  REFRESH_TOKEN_PREFIX,
  REUSE_GRACE_MS,
  rejectEnded,
  type SessionDeps,
} from './service'

/** Whether a string could be a refresh token this service issued (cheap, before any lookup). */
function plausible(token: string): boolean {
  return token.startsWith(REFRESH_TOKEN_PREFIX) && token.length <= MAX_REFRESH_TOKEN_LENGTH
}

/**
 * Trades a refresh token for a new access token and the next refresh token.
 *
 * Each refresh token works once. Presented again within the grace period it returns the same
 * next token (the first response may have been lost); presented again later, or when it is not
 * the newest, it is reuse: the whole session is ended, because a stolen token and its rightful
 * owner cannot be told apart. The user's Organization is read again on every refresh, so a role
 * change reaches the next token.
 *
 * @param onNoOrganization - Told the user id when the account has no Organization (reported).
 * @throws AppError `session.invalid_token`, `session.revoked`, `session.reuse_detected`,
 *   `session.expired`, `auth.user_banned`, `auth.no_organization`, `membership.unavailable`.
 */
export async function refresh(
  deps: SessionDeps,
  tenant: Tenant,
  refreshToken: string,
  onNoOrganization: (userId: string) => void
): Promise<IssuedSession> {
  if (!plausible(refreshToken)) {
    throw fail(AUTH_ERRORS['session.invalid_token'])
  }
  const tokenHash = sha256Hex(refreshToken)
  for (let pass = 0; pass < 2; pass++) {
    const now = deps.clock.now()
    const found = await deps.sessions.findToken(tenant.environmentId, tokenHash)
    if (!found) {
      throw fail(AUTH_ERRORS['session.invalid_token'])
    }
    const { token, session } = found
    rejectEnded(session, now)
    const user = await deps.users.findById(tenant.environmentId, session.userId)
    if (!user || user.bannedAt !== null) {
      await deps.sessions.revoke(tenant.environmentId, session.id, 'user_banned', now)
      throw fail(AUTH_ERRORS['auth.user_banned'])
    }
    const membership = await Membership.of(deps, formatId('usr', session.userId) as UserId)
    if (membership === null) {
      onNoOrganization(session.userId)
      throw fail(AUTH_ERRORS['auth.no_organization'])
    }
    const sign = await Tokens.signer(deps, tenant)
    const tokenSession = {
      id: session.id,
      userId: session.userId,
      authenticatedAt: session.factorVerifiedAt,
      authMethods: session.authMethods,
    }

    if (token.usedAt !== null) {
      const withinGrace = now.getTime() - token.usedAt.getTime() < REUSE_GRACE_MS
      const child =
        withinGrace && token.replacedById
          ? await deps.sessions.findTokenById(tenant.environmentId, token.replacedById)
          : null
      if (child && child.usedAt === null) {
        const access = await sign(tokenSession, membership, now)
        return issued(
          session.id,
          access,
          await deriveToken(deps, { parentId: token.id }),
          membership
        )
      }
      await deps.sessions.revoke(tenant.environmentId, session.id, 'reuse_detected', now)
      deps.logger.warn('refresh token reuse detected; session revoked', { sessionId: session.id })
      throw fail(AUTH_ERRORS['session.reuse_detected'])
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      throw fail(AUTH_ERRORS['session.expired'])
    }

    const idleExpiresAt = idleExpiry(now, session.absoluteExpiresAt)
    const child = await deriveToken(deps, { parentId: token.id })
    const rotated = await deps.sessions.rotate(tenant.environmentId, {
      parentId: token.id,
      child: {
        id: deps.ids.next(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        sessionId: session.id,
        tokenHash: sha256Hex(child),
        parentId: token.id,
        expiresAt: idleExpiresAt,
        createdAt: now,
      },
      at: now,
      idleExpiresAt,
    })
    if (rotated) {
      return issued(session.id, await sign(tokenSession, membership, now), child, membership)
    }
    // Lost a race with another refresh of the same token: look again, it is now a replay.
  }
  throw new Error('refresh rotation lost the race twice')
}

/**
 * Ends the session a refresh token belongs to. Idempotent: an unknown, spent or already ended
 * token succeeds too, so a client can always sign out and the answer says nothing about tokens.
 */
export async function signOut(
  deps: Pick<Container, 'clock' | 'sessions'>,
  tenant: Tenant,
  refreshToken: string
): Promise<void> {
  if (!plausible(refreshToken)) {
    return
  }
  const found = await deps.sessions.findToken(tenant.environmentId, sha256Hex(refreshToken))
  if (found) {
    await deps.sessions.revoke(tenant.environmentId, found.session.id, 'sign_out', deps.clock.now())
  }
}

/** One page of a user's usable sessions, newest first. */
export async function list(
  deps: Pick<Container, 'clock' | 'sessions'>,
  tenant: Tenant,
  userId: string,
  limit: number,
  after?: SessionPosition
): Promise<{ sessions: SessionRecord[]; hasMore: boolean }> {
  const rows = await deps.sessions.listActive(
    tenant.environmentId,
    userId,
    deps.clock.now(),
    limit + 1,
    after
  )
  return { sessions: rows.slice(0, limit), hasMore: rows.length > limit }
}
