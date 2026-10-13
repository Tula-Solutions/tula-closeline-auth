import type { NewUser, UserRecord, UserRepository, UserWithPassword } from '~/ports/user-repository'

type Stored = { user: UserRecord; passwordHash: string; passwordChangedAt: Date }

/** Users in process memory, for unit tests; behaves like the Postgres repository. */
export class MemoryUserRepository implements UserRepository {
  readonly #byId = new Map<string, Stored>()

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
    const { identityId: _i, credentialId: _c, passwordHash, ...record } = user
    const stored: Stored = {
      user: { ...record, bannedAt: null, lastSignInAt: null },
      passwordHash,
      passwordChangedAt: user.createdAt,
    }
    this.#byId.set(user.id, stored)
    return true
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
