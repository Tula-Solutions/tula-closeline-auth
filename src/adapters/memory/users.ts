import type { MemoryFlowAttemptStore } from '~/adapters/memory/flow-attempts'
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

type Stored = {
  user: UserRecord
  passwordHash: string | null
  passwordChangedAt: Date | null
  googleSubject: string | null
}

/** Users in process memory, for unit tests; behaves like the Postgres repository. */
export class MemoryUserRepository implements UserRepository {
  readonly #byId = new Map<string, Stored>()
  readonly #settleCase: ((environmentId: string, caseId: string) => Promise<boolean>) | undefined
  readonly #attempts: MemoryFlowAttemptStore | undefined
  /** The audit entries of links, as the Postgres adapter writes them (a test reads them). */
  readonly links: { userId: string; subject: string; auditId: string }[] = []

  /**
   * @param settleCase - Settles an abandon case; `false` rejects the account (nothing written).
   * @param attempts - The attempt store a Google user's creation consumes an attempt in.
   */
  constructor(
    settleCase?: (environmentId: string, caseId: string) => Promise<boolean>,
    attempts?: MemoryFlowAttemptStore
  ) {
    this.#settleCase = settleCase
    this.#attempts = attempts
  }

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<UserRecord | null> {
    const stored = this.#byId.get(id)
    return stored && stored.user.environmentId === environmentId ? { ...stored.user } : null
  }

  /** @inheritdoc */
  async findByEmail(environmentId: string, emailNormalized: string): Promise<UserRecord | null> {
    const found = this.#find(environmentId, emailNormalized)
    return found ? { ...found.user } : null
  }

  /** @inheritdoc */
  async findByEmailWithPassword(
    environmentId: string,
    emailNormalized: string
  ): Promise<UserWithPassword | null> {
    const found = this.#find(environmentId, emailNormalized)
    return found
      ? {
          user: { ...found.user },
          passwordHash: found.passwordHash,
          passwordChangedAt: found.passwordChangedAt,
        }
      : null
  }

  /** @inheritdoc */
  async create(user: NewUser): Promise<boolean> {
    if (
      this.#byId.has(user.id) ||
      (user.emailNormalized !== null && this.#find(user.environmentId, user.emailNormalized))
    ) {
      return false
    }
    const { identityId: _i, credentialId: _c, passwordHash, settlesAbandonCase, ...record } = user
    // Last, as in the Postgres transaction: a rejected settle writes no account.
    if (settlesAbandonCase !== undefined && this.#settleCase) {
      if (!(await this.#settleCase(user.environmentId, settlesAbandonCase))) {
        throw new AbandonCaseClaimed()
      }
    }
    const stored: Stored = {
      user: { ...record, bannedAt: null, lastSignInAt: null },
      passwordHash,
      passwordChangedAt: user.createdAt,
      googleSubject: null,
    }
    this.#byId.set(user.id, stored)
    return true
  }

  /** @inheritdoc */
  async findByGoogleSubject(environmentId: string, subject: string): Promise<UserRecord | null> {
    for (const stored of this.#byId.values()) {
      if (stored.user.environmentId === environmentId && stored.googleSubject === subject) {
        return { ...stored.user }
      }
    }
    return null
  }

  /** @inheritdoc */
  async findForGoogleLinking(
    environmentId: string,
    emailNormalized: string
  ): Promise<UserForLinking | null> {
    const found = this.#find(environmentId, emailNormalized)
    return found
      ? {
          user: { ...found.user },
          hasPassword: found.passwordHash !== null,
          hasGoogle: found.googleSubject !== null,
        }
      : null
  }

  /** @inheritdoc */
  async linkGoogle(link: NewGoogleLink): Promise<boolean> {
    const stored = this.#byId.get(link.userId)
    if (
      !stored ||
      stored.user.environmentId !== link.environmentId ||
      stored.googleSubject !== null ||
      (await this.findByGoogleSubject(link.environmentId, link.subject)) !== null
    ) {
      return false
    }
    stored.googleSubject = link.subject
    this.links.push({ userId: link.userId, subject: link.subject, auditId: link.auditId })
    return true
  }

  /** @inheritdoc */
  async createGoogleUser(user: NewGoogleUser): Promise<CreateGoogleUserResult> {
    const {
      emailIdentityId: _e,
      googleIdentityId: _g,
      subject,
      consume,
      settlesAbandonCase,
      ...record
    } = user
    if (
      this.#byId.has(user.id) ||
      (user.emailNormalized !== null && this.#find(user.environmentId, user.emailNormalized)) ||
      (await this.findByGoogleSubject(user.environmentId, subject)) !== null
    ) {
      return 'conflict'
    }
    if (settlesAbandonCase !== undefined && this.#settleCase) {
      if (!(await this.#settleCase(user.environmentId, settlesAbandonCase))) {
        throw new AbandonCaseClaimed()
      }
    }
    const consumed = await this.#attempts?.transition(
      user.environmentId,
      consume.id,
      consume.from,
      { status: 'complete', userId: user.id, state: consume.state, completedAt: consume.at },
      consume.at
    )
    if (consumed === false) {
      return 'consumed'
    }
    this.#byId.set(user.id, {
      user: { ...record, bannedAt: null, lastSignInAt: null },
      passwordHash: null,
      passwordChangedAt: null,
      googleSubject: subject,
    })
    return 'created'
  }

  /** Bans a user, as an administrator would (a test control; the service has no ban route). */
  ban(userId: string, at: Date): void {
    const stored = this.#byId.get(userId)
    if (stored) {
      stored.user.bannedAt = at
    }
  }

  /** @inheritdoc */
  async recordSignIn(environmentId: string, userId: string, at: Date): Promise<void> {
    const stored = this.#byId.get(userId)
    if (stored && stored.user.environmentId === environmentId) {
      stored.user.lastSignInAt = at
    }
  }

  /** @inheritdoc */
  async upgradePasswordHash(
    environmentId: string,
    userId: string,
    currentHash: string,
    passwordHash: string,
    _at: Date
  ): Promise<boolean> {
    const stored = this.#byId.get(userId)
    if (
      !stored ||
      stored.user.environmentId !== environmentId ||
      stored.passwordHash !== currentHash
    ) {
      return false
    }
    stored.passwordHash = passwordHash
    return true
  }

  #find(environmentId: string, emailNormalized: string): Stored | undefined {
    for (const stored of this.#byId.values()) {
      if (
        stored.user.environmentId === environmentId &&
        stored.user.emailNormalized === emailNormalized
      ) {
        return stored
      }
    }
    return undefined
  }
}
