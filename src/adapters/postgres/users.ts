import { and, eq } from 'drizzle-orm'
import { ABANDON_SETTLE, type Database, withEnvironment } from 'tula-closeline-db'
import { credentials, identities, users } from 'tula-closeline-db/schema'
import { hasSqlState, isUniqueViolation } from '~/adapters/postgres/errors'
import { statement } from '~/adapters/postgres/statement'
import {
  AbandonCaseClaimed,
  type NewUser,
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
