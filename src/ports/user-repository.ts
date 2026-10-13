/** A user as the service reads them; never carries a password hash. */
export interface UserRecord {
  id: string
  projectId: string
  environmentId: string
  email: string | null
  emailNormalized: string | null
  emailVerifiedAt: Date | null
  firstName: string | null
  lastName: string | null
  bannedAt: Date | null
  lastSignInAt: Date | null
  createdAt: Date
}

/** A user to create, with the ids of the identity and credential rows written alongside. */
export interface NewUser extends Omit<UserRecord, 'bannedAt' | 'lastSignInAt'> {
  identityId: string
  credentialId: string
  /** The argon2id hash of the password chosen at sign-up. */
  passwordHash: string
  /**
   * The abandon case (hub issue 36) to resolve as `done` in the same transaction as the account,
   * so a committed account can never leave an open case. Absent for an invitation sign-up.
   */
  resolvesAbandonCase?: string
}

/** A user as a password sign-in reads them: with the stored hash and when it was set. */
export interface UserWithPassword {
  user: UserRecord
  /** The current argon2id hash, or `null` for a user with no password. */
  passwordHash: string | null
  /** When the current password was set; `null` exactly when `passwordHash` is. */
  passwordChangedAt: Date | null
}

/** Users, their email identity and their password, scoped to an environment. */
export interface UserRepository {
  /** Returns the user, or `null` when there is none in this environment. */
  findById(environmentId: string, id: string): Promise<UserRecord | null>

  /** Returns the user with this normalized email address, or `null`. */
  findByEmail(environmentId: string, emailNormalized: string): Promise<UserRecord | null>

  /** Returns the user with the stored password hash for a sign-in, or `null`. */
  findByEmailWithPassword(
    environmentId: string,
    emailNormalized: string
  ): Promise<UserWithPassword | null>

  /**
   * Creates the user, their `email` identity and their password credential in one short
   * transaction (no call to another service happens inside it).
   *
   * @returns `false`, writing nothing, when the address or the user id is already taken. The
   *   caller tells the two apart with {@link UserRepository.findById}: a retry of the same
   *   sign-up finds its own id already there.
   */
  create(user: NewUser): Promise<boolean>

  /** Records a sign-in time. */
  recordSignIn(environmentId: string, userId: string, at: Date): Promise<void>

  /**
   * Replaces the stored hash with a stronger one for the same password (compare-and-set on the
   * hash that was verified), without moving the time the password was set.
   *
   * @returns `true` when the hash was replaced.
   */
  upgradePasswordHash(
    environmentId: string,
    userId: string,
    currentHash: string,
    passwordHash: string,
    at: Date
  ): Promise<boolean>
}
