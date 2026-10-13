/** Why a session ended early. */
export type RevokeReason = 'sign_out' | 'reuse_detected' | 'user_banned'

/** Which kind of client holds a session. */
export type SessionClient = 'web' | 'ios' | 'android' | 'server'

/** A session: one signed-in device, and the family of refresh tokens issued for it. */
export interface SessionRecord {
  id: string
  projectId: string
  environmentId: string
  userId: string
  client: SessionClient
  lastActiveAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
  /** When the user last proved who they are: the access token's `auth_time`. */
  factorVerifiedAt: Date
  /** What was proven, e.g. `['pwd']`: the access token's `amr`. */
  authMethods: string[]
  revokedAt: Date | null
  revokeReason: RevokeReason | null
  createdAt: Date
}

/** A refresh token as stored: only its SHA-256, never the token. */
export interface RefreshTokenRecord {
  id: string
  projectId: string
  environmentId: string
  sessionId: string
  tokenHash: string
  parentId: string | null
  replacedById: string | null
  usedAt: Date | null
  expiresAt: Date
  createdAt: Date
}

/** A session to create. */
export type NewSession = Omit<SessionRecord, 'revokedAt' | 'revokeReason'>

/** A refresh token to store. */
export type NewRefreshToken = Omit<RefreshTokenRecord, 'replacedById' | 'usedAt'>

/** One rotation: the parent token is spent and its child stored in one step. */
export interface Rotation {
  parentId: string
  child: NewRefreshToken
  at: Date
  idleExpiresAt: Date
}

/** Where a page of sessions starts: after this one in newest-first order. */
export interface SessionPosition {
  createdAt: Date
  id: string
}

/** Sessions and their refresh tokens in an environment. */
export interface SessionStore {
  /** Stores a session with its first refresh token, atomically. */
  create(session: NewSession, root: NewRefreshToken): Promise<void>

  /** Finds a refresh token by its hash, with its session; `null` when unknown. */
  findToken(
    environmentId: string,
    tokenHash: string
  ): Promise<{ token: RefreshTokenRecord; session: SessionRecord } | null>

  /** Finds a refresh token by id. */
  findTokenById(environmentId: string, id: string): Promise<RefreshTokenRecord | null>

  /** Finds a session by id. */
  findById(environmentId: string, id: string): Promise<SessionRecord | null>

  /**
   * Spends a refresh token and stores its child, and moves the session's idle expiry.
   *
   * @returns `false`, changing nothing, when the token was already spent (a concurrent refresh
   *   won) or the session was revoked.
   */
  rotate(environmentId: string, rotation: Rotation): Promise<boolean>

  /**
   * Ends a session; every refresh token of it stops working at once.
   *
   * @returns `true` when this call ended it, `false` when it was already ended or is unknown.
   */
  revoke(environmentId: string, sessionId: string, reason: RevokeReason, at: Date): Promise<boolean>

  /**
   * A user's sessions that are still usable at `now`, newest first.
   *
   * @param limit - At most this many rows; callers pass the page size plus one to detect more.
   */
  listActive(
    environmentId: string,
    userId: string,
    now: Date,
    limit: number,
    after?: SessionPosition
  ): Promise<SessionRecord[]>
}

/** Whether a session can still be used at `now`. */
export function isActive(session: SessionRecord, now: Date): boolean {
  return (
    session.revokedAt === null &&
    session.idleExpiresAt.getTime() > now.getTime() &&
    session.absoluteExpiresAt.getTime() > now.getTime()
  )
}
