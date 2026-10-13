import type { Jwk } from '~/modules/jwks/schema'

/** Lifecycle of a signing key: `next` is published ahead of use, `active` signs, `retired` verifies. */
export type SigningKeyStatus = 'next' | 'active' | 'retired'

/** The longest an access token lives, in milliseconds (15 minutes); no token outlives it. */
export const MAX_ACCESS_TOKEN_TTL_MS = 15 * 60_000

/**
 * How long a retired key stays published for verification: twice the longest access token, so
 * every token it signed has expired and external JWKS caches have refreshed.
 */
export const RETIRED_KEY_RETENTION_MS = 2 * MAX_ACCESS_TOKEN_TTL_MS

/**
 * Whether a key can verify tokens at `now`. Shared by every adapter so they agree on the rule.
 *
 * @returns `true` for `next` and `active` keys, and for keys retired within the retention window.
 */
export function canVerify(
  key: { status: SigningKeyStatus; retiredAt: Date | null },
  now: Date
): boolean {
  if (key.status !== 'retired') {
    return true
  }
  return (
    key.retiredAt !== null && now.getTime() - key.retiredAt.getTime() < RETIRED_KEY_RETENTION_MS
  )
}

/** A stored signing key. `privateKeyCiphertext` is sealed with the `signing-keys` secret box. */
export interface SigningKeyRecord {
  /** Also the JWT `kid`. */
  id: string
  projectId: string
  environmentId: string
  status: SigningKeyStatus
  /** Public JWK (its `kid` is set to `id` when served). */
  publicJwk: Jwk
  privateKeyCiphertext: string
  createdAt: Date
  activatedAt: Date | null
  retiredAt: Date | null
}

/** A key to store: bootstrap inserts `active` + `next`; rotation inserts a new `next`. */
export type NewSigningKey = Omit<SigningKeyRecord, 'retiredAt'>

/** One rotation step: `active → retired`, `next → active`, and a new `next`. */
export interface RotationPlan {
  retireId: string
  activateId: string
  next: NewSigningKey
}

/**
 * Signing keys of an environment.
 *
 * Invariants (partial unique indexes in Postgres, mirrored by the memory adapter): at most one
 * `active` and one `next` key per environment.
 *
 * Rotation rule, relied on by every verifier's cache: a key is published as `next` for at least
 * five minutes (the kit's rule; this service waits ten) before it becomes `active`.
 */
export interface SigningKeyStore {
  /**
   * Public keys that may verify tokens at `now`, newest first, at most `limit`.
   *
   * @param environmentId - The environment.
   * @param now - The current time, for the retirement window.
   * @param limit - The most keys to return.
   */
  verificationKeys(environmentId: string, now: Date, limit: number): Promise<Jwk[]>

  /** Every key of an environment, newest first, including long-retired ones, with ciphertext. */
  list(environmentId: string): Promise<SigningKeyRecord[]>

  /**
   * Insert keys atomically (all or none).
   *
   * @returns `false` when another writer already holds an `active`/`next` slot (nothing inserted).
   */
  insert(environmentId: string, keys: NewSigningKey[]): Promise<boolean>

  /**
   * Apply a rotation atomically.
   *
   * @returns `false` when the keys are no longer in the expected states (a concurrent rotation
   *   won); nothing is changed in that case.
   */
  rotate(environmentId: string, plan: RotationPlan, at: Date): Promise<boolean>
}
