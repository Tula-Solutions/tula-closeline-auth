import type { StoredFlowStatus } from '~/modules/flow/schema'

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
   * The abandon case (hub issue 36) this request recorded, settled as `not_needed` by the last
   * statement of the account transaction. It locks the row the sweep's claim locks, so an account
   * and a claimed case cannot both exist: when the sweep claimed first, `create` throws
   * {@link AbandonCaseClaimed} and writes nothing. Absent for an invitation sign-up.
   */
  settlesAbandonCase?: string
}

/**
 * Thrown by {@link UserRepository.create}, with nothing written, when the sweep claimed the
 * attempt's abandon case before the account could commit: the Organization is (or is about to be)
 * abandoned, so the person must sign up again.
 */
export class AbandonCaseClaimed extends Error {
  constructor() {
    super('the abandon case was claimed before the account could be written')
    this.name = 'AbandonCaseClaimed'
  }
}

/** A user as a password sign-in reads them: with the stored hash and when it was set. */
export interface UserWithPassword {
  user: UserRecord
  /** The current argon2id hash, or `null` for a user with no password. */
  passwordHash: string | null
  /** When the current password was set; `null` exactly when `passwordHash` is. */
  passwordChangedAt: Date | null
}

/** A user found by address, for Sign in with Google's linking rule (ADR 0019). */
export interface UserForLinking {
  user: UserRecord
  /** Whether the user has a password credential. */
  hasPassword: boolean
  /** Whether the user already has a Linked Google account. */
  hasGoogle: boolean
}

/** A Linked Google account to add to an existing user, and the review record of the link. */
export interface NewGoogleLink {
  projectId: string
  environmentId: string
  userId: string
  identityId: string
  /** Google's `sub`. */
  subject: string
  /** The id of the audit entry that records the link. */
  auditId: string
  at: Date
}

/** The attempt a new Google user's creation consumes, in the transaction that writes the user. */
export interface ConsumedAttempt {
  id: string
  /** The step the attempt must still be on. */
  from: StoredFlowStatus
  at: Date
  /** The state the finished attempt keeps. */
  state: Record<string, unknown>
}

/** A new user who signed up with Google: no password, a verified address, a `google` identity. */
export interface NewGoogleUser extends Omit<UserRecord, 'bannedAt' | 'lastSignInAt'> {
  /** The id of the `email` identity (every user has one, as for an email sign-up). */
  emailIdentityId: string
  /** The id of the `google` identity. */
  googleIdentityId: string
  /** Google's `sub`. */
  subject: string
  /** Consumed (completed) in the same transaction; of two racing calls exactly one succeeds. */
  consume: ConsumedAttempt
  /** As for {@link NewUser.settlesAbandonCase}. */
  settlesAbandonCase?: string
}

/** How {@link UserRepository.createGoogleUser} ended. */
export type CreateGoogleUserResult =
  /** The user, the identities and the consumed attempt were written. */
  | 'created'
  /** Nothing was written: the user id or address or `sub` is taken. */
  | 'conflict'
  /** Nothing was written: the attempt was no longer on the step (a racing call won, or it expired). */
  | 'consumed'

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

  /** Returns the user whose `google` identity has this `sub`, or `null`. Never looks at an address. */
  findByGoogleSubject(environmentId: string, subject: string): Promise<UserRecord | null>

  /** Returns the user with this normalized address, with what the linking rule needs, or `null`. */
  findForGoogleLinking(
    environmentId: string,
    emailNormalized: string
  ): Promise<UserForLinking | null>

  /**
   * Adds a `google` identity to an existing user and records the link, in one transaction.
   *
   * @returns `false`, writing nothing, when the `sub` or the user already has a Google identity.
   */
  linkGoogle(link: NewGoogleLink): Promise<boolean>

  /**
   * Writes a Google user (no credential) with its `email` and `google` identities and consumes
   * the attempt, all in one transaction. Nothing is held across a call to another service.
   *
   * @throws AbandonCaseClaimed as {@link UserRepository.create}.
   */
  createGoogleUser(user: NewGoogleUser): Promise<CreateGoogleUserResult>

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
