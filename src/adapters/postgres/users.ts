import { and, eq, gt, isNull } from 'drizzle-orm'
import { ABANDON_SETTLE, type Database, withEnvironment } from 'tula-closeline-db'
import { auditLogs, credentials, flowAttempts, identities, users } from 'tula-closeline-db/schema'
import { hasSqlState, isUniqueViolation } from '~/adapters/postgres/errors'
import { statement } from '~/adapters/postgres/statement'
import {
  AbandonCaseClaimed,
  type CreateGoogleUserResult,
  type NewGoogleLink,
  type NewGoogleUser,
  type NewUser,
  type UserForLinking,
  type UserRecord,
  type UserRepository,
  type UserWithPassword,
} from '~/ports/user-repository'

const columns = {
  id: users.id,
  projectId: users.projectId,
  environmentId: users.environmentId,
  email: users.email,
  emailNormalized: users.emailNormalized,
  emailVerifiedAt: users.emailVerifiedAt,
  firstName: users.firstName,
  lastName: users.lastName,
  bannedAt: users.bannedAt,
  lastSignInAt: users.lastSignInAt,
  createdAt: users.createdAt,
}

/** Thrown inside the Google user's transaction to roll it back when the attempt was already used. */
class AttemptConsumed extends Error {}

/** Users, identities and credentials in `auth`, inside the environment's RLS scope. */
export class PostgresUserRepository implements UserRepository {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<UserRecord | null> {
    const [row] = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(users)
        .where(and(eq(users.id, id), eq(users.environmentId, environmentId)))
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findByEmail(environmentId: string, emailNormalized: string): Promise<UserRecord | null> {
    const [row] = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(users)
        .where(
          and(eq(users.emailNormalized, emailNormalized), eq(users.environmentId, environmentId))
        )
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findByEmailWithPassword(
    environmentId: string,
    emailNormalized: string
  ): Promise<UserWithPassword | null> {
    const [row] = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .select({
          user: columns,
          passwordHash: credentials.secret,
          passwordChangedAt: credentials.secretChangedAt,
        })
        .from(users)
        .leftJoin(
          credentials,
          and(
            eq(credentials.userId, users.id),
            eq(credentials.environmentId, users.environmentId),
            eq(credentials.type, 'password')
          )
        )
        .where(
          and(eq(users.emailNormalized, emailNormalized), eq(users.environmentId, environmentId))
        )
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async create(user: NewUser): Promise<boolean> {
    const { identityId, credentialId, passwordHash, settlesAbandonCase, ...record } = user
    const scope = { projectId: user.projectId, environmentId: user.environmentId }
    const stamps = { createdAt: user.createdAt, updatedAt: user.createdAt }
    try {
      await withEnvironment(this.db, user.environmentId, async (tx) => {
        // The unique key on the address is the arbiter: a concurrent insert of the same address
        // waits here for the other transaction and then fails.
        await tx.insert(users).values({ ...record, updatedAt: user.createdAt })
        await tx.insert(identities).values({
          id: identityId,
          ...scope,
          userId: user.id,
          provider: 'email',
          providerSubject: user.emailNormalized ?? '',
          ...stamps,
        })
        await tx.insert(credentials).values({
          id: credentialId,
          ...scope,
          userId: user.id,
          type: 'password',
          secret: passwordHash,
          secretChangedAt: user.createdAt,
          ...stamps,
        })
        if (settlesAbandonCase !== undefined) {
          // Last statement, same transaction: it locks the row the sweep's claim locks (both at
          // READ COMMITTED), so the account and a claimed case cannot both commit. No row means
          // the sweep claimed (or resolved) the case first: roll the whole account back.
          const settled = await tx.execute(
            statement(ABANDON_SETTLE, [settlesAbandonCase, user.environmentId])
          )
          if (settled.rows.length === 0) {
            throw new AbandonCaseClaimed()
          }
        }
      })
      return true
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false
      }
      if (error instanceof AbandonCaseClaimed || hasSqlState(error, '40001')) {
        // A serialization failure here can only be the settle racing the claim: a lost race too.
        throw error instanceof AbandonCaseClaimed ? error : new AbandonCaseClaimed()
      }
      throw error
    }
  }

  /** @inheritdoc */
  async findByGoogleSubject(environmentId: string, subject: string): Promise<UserRecord | null> {
    const [row] = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(identities)
        .innerJoin(
          users,
          and(eq(users.id, identities.userId), eq(users.environmentId, identities.environmentId))
        )
        .where(
          and(
            eq(identities.environmentId, environmentId),
            eq(identities.provider, 'google'),
            eq(identities.providerSubject, subject)
          )
        )
        .limit(1)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findForGoogleLinking(
    environmentId: string,
    emailNormalized: string
  ): Promise<UserForLinking | null> {
    return withEnvironment(this.db, environmentId, async (tx) => {
      const [user] = await tx
        .select(columns)
        .from(users)
        .where(
          and(eq(users.emailNormalized, emailNormalized), eq(users.environmentId, environmentId))
        )
        .limit(1)
      if (!user) {
        return null
      }
      const [password] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, user.id),
            eq(credentials.environmentId, environmentId),
            eq(credentials.type, 'password')
          )
        )
        .limit(1)
      const [google] = await tx
        .select({ id: identities.id })
        .from(identities)
        .where(
          and(
            eq(identities.userId, user.id),
            eq(identities.environmentId, environmentId),
            eq(identities.provider, 'google')
          )
        )
        .limit(1)
      return { user, hasPassword: password !== undefined, hasGoogle: google !== undefined }
    })
  }

  /** @inheritdoc */
  async linkGoogle(link: NewGoogleLink): Promise<boolean> {
    const scope = { projectId: link.projectId, environmentId: link.environmentId }
    try {
      await withEnvironment(this.db, link.environmentId, async (tx) => {
        // The unique keys (user and provider; provider and subject) are the arbiter of a race.
        await tx.insert(identities).values({
          id: link.identityId,
          ...scope,
          userId: link.userId,
          provider: 'google',
          providerSubject: link.subject,
          createdAt: link.at,
          updatedAt: link.at,
        })
        await tx.insert(auditLogs).values({
          id: link.auditId,
          ...scope,
          actorType: 'user',
          actorId: link.userId,
          action: 'google_linked',
          targetType: 'user',
          targetId: link.userId,
          metadata: { provider: 'google' },
          occurredAt: link.at,
        })
      })
      return true
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false
      }
      throw error
    }
  }

  /** @inheritdoc */
  async createGoogleUser(user: NewGoogleUser): Promise<CreateGoogleUserResult> {
    const { emailIdentityId, googleIdentityId, subject, consume, settlesAbandonCase, ...record } =
      user
    const scope = { projectId: user.projectId, environmentId: user.environmentId }
    const stamps = { createdAt: user.createdAt, updatedAt: user.createdAt }
    try {
      await withEnvironment(this.db, user.environmentId, async (tx) => {
        await tx.insert(users).values({ ...record, updatedAt: user.createdAt })
        await tx.insert(identities).values({
          id: emailIdentityId,
          ...scope,
          userId: user.id,
          provider: 'email',
          providerSubject: user.emailNormalized ?? '',
          ...stamps,
        })
        await tx.insert(identities).values({
          id: googleIdentityId,
          ...scope,
          userId: user.id,
          provider: 'google',
          providerSubject: subject,
          ...stamps,
        })
        // The attempt is consumed in this transaction, after the unique keys have had their say:
        // of two racing calls exactly one finds the attempt still on its step.
        const consumed = await tx
          .update(flowAttempts)
          .set({
            status: 'complete',
            userId: user.id,
            state: consume.state,
            completedAt: consume.at,
            updatedAt: consume.at,
          })
          .where(
            and(
              eq(flowAttempts.id, consume.id),
              eq(flowAttempts.environmentId, user.environmentId),
              eq(flowAttempts.status, consume.from),
              isNull(flowAttempts.completedAt),
              gt(flowAttempts.expiresAt, consume.at)
            )
          )
          .returning({ id: flowAttempts.id })
        if (consumed.length === 0) {
          throw new AttemptConsumed()
        }
        if (settlesAbandonCase !== undefined) {
          const settled = await tx.execute(
            statement(ABANDON_SETTLE, [settlesAbandonCase, user.environmentId])
          )
          if (settled.rows.length === 0) {
            throw new AbandonCaseClaimed()
          }
        }
      })
      return 'created'
    } catch (error) {
      if (error instanceof AttemptConsumed) {
        return 'consumed'
      }
      if (isUniqueViolation(error)) {
        return 'conflict'
      }
      if (error instanceof AbandonCaseClaimed || hasSqlState(error, '40001')) {
        throw error instanceof AbandonCaseClaimed ? error : new AbandonCaseClaimed()
      }
      throw error
    }
  }

  /** @inheritdoc */
  async recordSignIn(environmentId: string, userId: string, at: Date): Promise<void> {
    await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .update(users)
        .set({ lastSignInAt: at, updatedAt: at })
        .where(and(eq(users.id, userId), eq(users.environmentId, environmentId)))
    )
  }

  /** @inheritdoc */
  async upgradePasswordHash(
    environmentId: string,
    userId: string,
    currentHash: string,
    passwordHash: string,
    at: Date
  ): Promise<boolean> {
    const rows = await withEnvironment(this.db, environmentId, (tx) =>
      tx
        .update(credentials)
        // Not `secretChangedAt`: this is the same password, and hashing it again must not
        // make an old password look new.
        .set({ secret: passwordHash, updatedAt: at })
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.environmentId, environmentId),
            eq(credentials.type, 'password'),
            eq(credentials.secret, currentHash)
          )
        )
        .returning({ id: credentials.id })
    )
    return rows.length === 1
  }
}
