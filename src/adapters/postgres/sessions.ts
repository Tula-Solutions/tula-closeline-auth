import { and, desc, eq, gt, isNull, lt, or, type SQL } from 'drizzle-orm'
import { type Database, withEnvironment } from 'tula-closeline-db'
import { refreshTokens, sessions } from 'tula-closeline-db/schema'
import { isUniqueViolation, LostRace } from '~/adapters/postgres/errors'
import type {
  NewRefreshToken,
  NewSession,
  RefreshTokenRecord,
  RevokeReason,
  Rotation,
  SessionPosition,
  SessionRecord,
  SessionStore,
} from '~/ports/session-store'

/** The one session profile this service has; the column exists for the source's profiles. */
const PROFILE = 'default'

const sessionColumns = {
  id: sessions.id,
  projectId: sessions.projectId,
  environmentId: sessions.environmentId,
  userId: sessions.userId,
  client: sessions.client,
  lastActiveAt: sessions.lastActiveAt,
  idleExpiresAt: sessions.idleExpiresAt,
  absoluteExpiresAt: sessions.absoluteExpiresAt,
  factorVerifiedAt: sessions.factorVerifiedAt,
  authMethods: sessions.authMethods,
  revokedAt: sessions.revokedAt,
  revokeReason: sessions.revokeReason,
  createdAt: sessions.createdAt,
}

const tokenColumns = {
  id: refreshTokens.id,
  projectId: refreshTokens.projectId,
  environmentId: refreshTokens.environmentId,
  sessionId: refreshTokens.sessionId,
  tokenHash: refreshTokens.tokenHash,
  parentId: refreshTokens.parentId,
  replacedById: refreshTokens.replacedById,
  usedAt: refreshTokens.usedAt,
  expiresAt: refreshTokens.expiresAt,
  sealedNextToken: refreshTokens.sealedNextToken,
  createdAt: refreshTokens.createdAt,
}

type SessionRow = Omit<SessionRecord, 'absoluteExpiresAt' | 'factorVerifiedAt' | 'revokeReason'> & {
  absoluteExpiresAt: Date | null
  factorVerifiedAt: Date | null
  /** The table also allows reasons the source product wrote; this service writes three. */
  revokeReason: string | null
}

/** Rows written without a cap or proof time (not by this service) read as the creation time. */
function toSession(row: SessionRow): SessionRecord {
  return {
    ...row,
    revokeReason: row.revokeReason as RevokeReason | null,
    absoluteExpiresAt: row.absoluteExpiresAt ?? row.idleExpiresAt,
    factorVerifiedAt: row.factorVerifiedAt ?? row.createdAt,
  }
}

/** Sessions and refresh tokens in `auth`, inside the environment's RLS scope. */
export class PostgresSessionStore implements SessionStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async create(session: NewSession, root: NewRefreshToken): Promise<void> {
    await withEnvironment(this.db, session.environmentId, async (tx) => {
      await tx.insert(sessions).values({
        ...session,
        profile: PROFILE,
        type: 'hybrid',
        authMethods: session.authMethods,
        updatedAt: session.createdAt,
      })
      await tx.insert(refreshTokens).values({ ...root, updatedAt: root.createdAt })
    })
  }

  /** @inheritdoc */
  async findToken(environmentId: string, tokenHash: string) {
    const [row] = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .select({ token: tokenColumns, session: sessionColumns })
        .from(refreshTokens)
        .innerJoin(
          sessions,
          and(
            eq(sessions.id, refreshTokens.sessionId),
            eq(sessions.environmentId, refreshTokens.environmentId)
          )
        )
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            eq(refreshTokens.environmentId, environmentId)
          )
        )
        .limit(1)
    )
    return row ? { token: row.token, session: toSession(row.session) } : null
  }

  /** @inheritdoc */
  async findTokenById(environmentId: string, id: string): Promise<RefreshTokenRecord | null> {
    const [row] = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .select(tokenColumns)
        .from(refreshTokens)
        .where(and(eq(refreshTokens.id, id), eq(refreshTokens.environmentId, environmentId)))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<SessionRecord | null> {
    const [row] = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .select(sessionColumns)
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.environmentId, environmentId)))
        .limit(1)
    )
    return row ? toSession(row) : null
  }

  /** @inheritdoc */
  async rotate(environmentId: string, rotation: Rotation): Promise<boolean> {
    try {
      await withEnvironment(this.db, environmentId, async (tx) => {
        const [parent] = await tx
          .select({ sessionId: refreshTokens.sessionId, parentId: refreshTokens.parentId })
          .from(refreshTokens)
          .where(
            and(
              eq(refreshTokens.id, rotation.parentId),
              eq(refreshTokens.environmentId, environmentId)
            )
          )
          .limit(1)
        if (!parent) {
          throw new LostRace()
        }
        // The session's row lock serializes concurrent rotations of one token family and makes a
        // revocation either come before this rotation or after it, never in between.
        const touched = await tx
          .update(sessions)
          .set({
            lastActiveAt: rotation.at,
            idleExpiresAt: rotation.idleExpiresAt,
            updatedAt: rotation.at,
          })
          .where(
            and(
              eq(sessions.id, parent.sessionId),
              eq(sessions.environmentId, environmentId),
              isNull(sessions.revokedAt)
            )
          )
          .returning({ id: sessions.id })
        if (touched.length !== 1) {
          throw new LostRace()
        }
        const spent = await tx
          .update(refreshTokens)
          .set({ usedAt: rotation.at, updatedAt: rotation.at })
          .where(
            and(
              eq(refreshTokens.id, rotation.parentId),
              eq(refreshTokens.environmentId, environmentId),
              isNull(refreshTokens.usedAt)
            )
          )
          .returning({ id: refreshTokens.id })
        if (spent.length !== 1) {
          throw new LostRace()
        }
        await tx
          .insert(refreshTokens)
          .values({ ...rotation.child, updatedAt: rotation.child.createdAt })
        await tx
          .update(refreshTokens)
          .set({
            replacedById: rotation.child.id,
            sealedNextToken: Buffer.from(rotation.sealedNextToken),
          })
          .where(
            and(
              eq(refreshTokens.id, rotation.parentId),
              eq(refreshTokens.environmentId, environmentId)
            )
          )
        if (parent.parentId) {
          // The token before this one can now only be replayed as reuse: drop its sealed copy.
          await tx
            .update(refreshTokens)
            .set({ sealedNextToken: null })
            .where(
              and(
                eq(refreshTokens.id, parent.parentId),
                eq(refreshTokens.environmentId, environmentId)
              )
            )
        }
      })
      return true
    } catch (error) {
      if (error instanceof LostRace || isUniqueViolation(error)) {
        return false
      }
      throw error
    }
  }

  /** @inheritdoc */
  async clearSealedNextToken(environmentId: string, id: string): Promise<void> {
    await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .update(refreshTokens)
        .set({ sealedNextToken: null })
        .where(and(eq(refreshTokens.id, id), eq(refreshTokens.environmentId, environmentId)))
    )
  }

  /** @inheritdoc */
  async revoke(
    environmentId: string,
    sessionId: string,
    reason: RevokeReason,
    at: Date
  ): Promise<boolean> {
    const rows = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: at, revokeReason: reason, updatedAt: at })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.environmentId, environmentId),
            isNull(sessions.revokedAt)
          )
        )
        .returning({ id: sessions.id })
    )
    return rows.length === 1
  }

  /** @inheritdoc */
  async listActive(
    environmentId: string,
    userId: string,
    now: Date,
    limit: number,
    after?: SessionPosition
  ): Promise<SessionRecord[]> {
    const position: SQL | undefined = after
      ? or(
          lt(sessions.createdAt, after.createdAt),
          and(eq(sessions.createdAt, after.createdAt), lt(sessions.id, after.id))
        )
      : undefined
    const rows = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .select(sessionColumns)
        .from(sessions)
        .where(
          and(
            eq(sessions.environmentId, environmentId),
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, now),
            or(isNull(sessions.absoluteExpiresAt), gt(sessions.absoluteExpiresAt, now)),
            position
          )
        )
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(limit)
    )
    return rows.map(toSession)
  }
}
