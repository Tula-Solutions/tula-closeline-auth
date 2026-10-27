import {
  isActive,
  type NewRefreshToken,
  type NewSession,
  type RefreshTokenRecord,
  type RevokeReason,
  type Rotation,
  type SessionPosition,
  type SessionRecord,
  type SessionStore,
} from '~/ports/session-store'

/** Sessions and refresh tokens in process memory, for unit tests; behaves like Postgres. */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>()
  readonly #tokens = new Map<string, RefreshTokenRecord>()

  /** @inheritdoc */
  async create(session: NewSession, root: NewRefreshToken): Promise<void> {
    this.#sessions.set(session.id, { ...session, revokedAt: null, revokeReason: null })
    this.#tokens.set(root.id, { ...root, replacedById: null, usedAt: null, sealedNextToken: null })
  }

  /** @inheritdoc */
  async findToken(environmentId: string, tokenHash: string) {
    for (const token of this.#tokens.values()) {
      if (token.environmentId === environmentId && token.tokenHash === tokenHash) {
        const session = this.#sessions.get(token.sessionId)
        return session ? { token: { ...token }, session: { ...session } } : null
      }
    }
    return null
  }

  /** @inheritdoc */
  async findTokenById(environmentId: string, id: string): Promise<RefreshTokenRecord | null> {
    const token = this.#tokens.get(id)
    return token && token.environmentId === environmentId ? { ...token } : null
  }

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<SessionRecord | null> {
    const session = this.#sessions.get(id)
    return session && session.environmentId === environmentId ? { ...session } : null
  }

  /** @inheritdoc */
  async rotate(environmentId: string, rotation: Rotation): Promise<boolean> {
    const parent = this.#tokens.get(rotation.parentId)
    const session = parent && this.#sessions.get(parent.sessionId)
    if (
      !parent ||
      !session ||
      parent.environmentId !== environmentId ||
      parent.usedAt !== null ||
      session.revokedAt !== null
    ) {
      return false
    }
    parent.usedAt = rotation.at
    parent.replacedById = rotation.child.id
    parent.sealedNextToken = new Uint8Array(rotation.sealedNextToken)
    const grandparent = parent.parentId ? this.#tokens.get(parent.parentId) : undefined
    if (grandparent) {
      grandparent.sealedNextToken = null
    }
    this.#tokens.set(rotation.child.id, {
      ...rotation.child,
      replacedById: null,
      usedAt: null,
      sealedNextToken: null,
    })
    session.lastActiveAt = rotation.at
    session.idleExpiresAt = rotation.idleExpiresAt
    return true
  }

  /** @inheritdoc */
  async clearSealedNextToken(environmentId: string, id: string): Promise<void> {
    const token = this.#tokens.get(id)
    if (token && token.environmentId === environmentId) {
      token.sealedNextToken = null
    }
  }

  /** @inheritdoc */
  async revoke(
    environmentId: string,
    sessionId: string,
    reason: RevokeReason,
    at: Date
  ): Promise<boolean> {
    const session = this.#sessions.get(sessionId)
    if (!session || session.environmentId !== environmentId || session.revokedAt !== null) {
      return false
    }
    session.revokedAt = at
    session.revokeReason = reason
    return true
  }

  /** @inheritdoc */
  async listActive(
    environmentId: string,
    userId: string,
    now: Date,
    limit: number,
    after?: SessionPosition
  ): Promise<SessionRecord[]> {
    return [...this.#sessions.values()]
      .filter((s) => s.environmentId === environmentId && s.userId === userId && isActive(s, now))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .filter(
        (s) =>
          !after ||
          s.createdAt.getTime() < after.createdAt.getTime() ||
          (s.createdAt.getTime() === after.createdAt.getTime() && s.id < after.id)
      )
      .slice(0, limit)
      .map((s) => ({ ...s }))
  }
}
