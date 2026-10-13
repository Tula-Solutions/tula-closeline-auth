import { AUTH_ERRORS, formatId, type UserId } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { fail } from '~/errors'
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
 * Applies again, after the call to core, what a replay was let through on: the session has not
 * ended or expired, the user is not banned, and the next token has not been spent. The grace
 * window is not measured again: a client that retried inside it is not reuse because core was slow.
 */
async function recheckReplay(
  deps: SessionDeps,
  tenant: Tenant,
  tokenHash: string,
  now: Date
): Promise<void> {
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
  const child = token.replacedById
    ? await deps.sessions.findTokenById(tenant.environmentId, token.replacedById)
    : null
  if (!child || child.usedAt !== null) {
    await deps.sessions.revoke(tenant.environmentId, session.id, 'reuse_detected', now)
    deps.logger.warn('refresh token reuse detected; session revoked', { sessionId: session.id })
    throw fail(AUTH_ERRORS['session.reuse_detected'])
  }
}

/**
 * Trades a refresh token for a new access token and the next refresh token.
 *
 * Each refresh token works once. Presented again within the grace period it returns the same
 * next token (the first response may have been lost); presented again later, or when it is not
 * the newest, it is reuse: the whole session is ended, because a stolen token and its rightful
 * owner cannot be told apart. The user's Organization is read again on every refresh, so a role
 * change reaches the next token. What needs no answer from core (an ended session, a spent token
 * past its grace, an expired token) is decided before core is asked, and core is asked once per
 * request; the clock is read again after the answer for the times the new tokens carry, and a
 * replay and a rotation are each checked again then (the session may have ended or expired, the
 * user been banned, the next token been spent, while core was being asked).
 *
 * @param onNoOrganization - Told the user id when the account has no Organization (reported).
 * @throws AppError `session.invalid_token`, `session.revoked`, `session.reuse_detected`,
 *   `session.expired`, `auth.user_banned`, `auth.no_organization`, `organization.deleted` (the
 *   session is ended), `membership.unavailable` (nothing rotated; retry the same token).
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
  // Core is asked at most once per request: a retry of the rotation after a lost race reuses the
  // answer, so one request is never more than one call (and never two bounds) behind core.
  let asked: { membership: Awaited<ReturnType<typeof Membership.of>> } | undefined
  for (let pass = 0; pass < 2; pass++) {
    const checkedAt = deps.clock.now()
    const found = await deps.sessions.findToken(tenant.environmentId, tokenHash)
    if (!found) {
      throw fail(AUTH_ERRORS['session.invalid_token'])
    }
    const { token, session } = found
    rejectEnded(session, checkedAt)
    const user = await deps.users.findById(tenant.environmentId, session.userId)
    if (!user || user.bannedAt !== null) {
      await deps.sessions.revoke(tenant.environmentId, session.id, 'user_banned', checkedAt)
      throw fail(AUTH_ERRORS['auth.user_banned'])
    }

    // Everything that needs no answer from core is decided first, so a replayed or expired token
    // costs no call, and an outage can never defer reuse detection.
    let replay = false
    if (token.usedAt !== null) {
      const withinGrace = checkedAt.getTime() - token.usedAt.getTime() < REUSE_GRACE_MS
      const child =
        withinGrace && token.replacedById
          ? await deps.sessions.findTokenById(tenant.environmentId, token.replacedById)
          : null
      if (!child || child.usedAt !== null) {
        await deps.sessions.revoke(tenant.environmentId, session.id, 'reuse_detected', checkedAt)
        deps.logger.warn('refresh token reuse detected; session revoked', {
          sessionId: session.id,
        })
        throw fail(AUTH_ERRORS['session.reuse_detected'])
      }
      replay = true
    } else if (token.expiresAt.getTime() <= checkedAt.getTime()) {
      throw fail(AUTH_ERRORS['session.expired'])
    }

    const askedNow = asked === undefined
    if (asked === undefined) {
      try {
        asked = { membership: await Membership.of(deps, formatId('usr', session.userId) as UserId) }
      } catch (error) {
        if (Membership.isOrganizationDeleted(error)) {
          // Their Organization is gone: this session can never get a token again.
          await deps.sessions.revoke(
            tenant.environmentId,
            session.id,
            'revoked_by_admin',
            deps.clock.now()
          )
        }
        // Any other failure (core unavailable) changed nothing: the same token can be retried.
        throw error
      }
    }
    const { membership } = asked
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
    // Read again: core may have taken seconds, and the access token's issue time and the
    // rotation time (which starts the grace window) are when they happen, not when we began.
    const now = deps.clock.now()

    if (replay) {
      // Core may have taken seconds: what was true before the call may not be now, so the
      // session, the user and the next token are read again before the same next token is
      // handed out (a lost race that already waited on core in this request needs no re-read).
      if (askedNow) {
        await recheckReplay(deps, tenant, tokenHash, now)
      }
      // The first response may have been lost: the same next token is returned.
      const access = await sign(tokenSession, membership, now)
      return issued(
        session.id,
        access,
        await deriveToken(deps, { parentId: token.id }),
        membership,
        session.absoluteExpiresAt
      )
    }

    // The token and the session may have run out while core was being asked; the rotation's
    // compare-and-set does not look at expiry, so it is decided here, from the rows already read.
    rejectEnded(session, now)
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
      return issued(
        session.id,
        await sign(tokenSession, membership, now),
        child,
        membership,
        session.absoluteExpiresAt
      )
    }
    // Lost a race with another refresh of the same token: look again, it is now a replay (the
    // answer from core is kept).
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
