import { and, desc, eq } from 'drizzle-orm'
import { type Database, withEnvironment } from 'tula-closeline-db'
import { signingKeys } from 'tula-closeline-db/schema'
import { isUniqueViolation, LostRace } from '~/adapters/postgres/errors'
import { type Jwk, jwkSchema } from '~/modules/jwks/schema'
import {
  canVerify,
  type NewSigningKey,
  type RotationPlan,
  type SigningKeyRecord,
  type SigningKeyStore,
} from '~/ports/signing-key-store'

const columns = {
  id: signingKeys.id,
  projectId: signingKeys.projectId,
  environmentId: signingKeys.environmentId,
  status: signingKeys.status,
  publicJwk: signingKeys.publicJwk,
  privateKeyCiphertext: signingKeys.privateKeyCiphertext,
  createdAt: signingKeys.createdAt,
  activatedAt: signingKeys.activatedAt,
  retiredAt: signingKeys.retiredAt,
}

function toValues(environmentId: string, key: NewSigningKey) {
  // The kid is the row id; it is not duplicated inside the stored JSON.
  const { kid: _kid, ...publicJwk } = key.publicJwk
  return {
    id: key.id,
    projectId: key.projectId,
    environmentId,
    status: key.status,
    publicJwk,
    privateKeyCiphertext: key.privateKeyCiphertext,
    activatedAt: key.activatedAt,
    createdAt: key.createdAt,
    updatedAt: key.createdAt,
  }
}

/** Signing keys in `auth.signing_keys`, read and written inside the environment's RLS scope. */
export function createPostgresSigningKeyStore(db: Database): SigningKeyStore {
  const rows = (environmentId: string) =>
    withEnvironment(db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(signingKeys)
        // RLS already scopes rows; the explicit filter uses the index and is defence in depth.
        .where(eq(signingKeys.environmentId, environmentId))
        .orderBy(desc(signingKeys.createdAt), desc(signingKeys.id))
    )
  // A row whose stored JWK is malformed is skipped, never served: JWKS holds valid keys only.
  const jwkOf = (row: { id: string; publicJwk: unknown }): Jwk | null => {
    const parsed = jwkSchema.safeParse({ ...(row.publicJwk as object), kid: row.id })
    return parsed.success ? parsed.data : null
  }

  return {
    async verificationKeys(environmentId, now, limit) {
      const keys: Jwk[] = []
      for (const row of await rows(environmentId)) {
        const jwk = canVerify(row, now) ? jwkOf(row) : null
        if (jwk && keys.length < limit) {
          keys.push(jwk)
        }
      }
      return keys
    },

    async list(environmentId) {
      const records: SigningKeyRecord[] = []
      for (const row of await rows(environmentId)) {
        const jwk = jwkOf(row)
        if (jwk) {
          records.push({ ...row, publicJwk: jwk })
        }
      }
      return records
    },

    async insert(environmentId, keys) {
      try {
        await withEnvironment(db, environmentId, (tx) =>
          tx.insert(signingKeys).values(keys.map((key) => toValues(environmentId, key)))
        )
        return true
      } catch (error) {
        if (isUniqueViolation(error)) {
          return false
        }
        throw error
      }
    },

    async rotate(environmentId, plan: RotationPlan, at) {
      try {
        await withEnvironment(db, environmentId, async (tx) => {
          // Order matters under the partial unique indexes: free the active slot, then the next
          // slot, then fill next again. Each update is guarded by the expected current status.
          const retired = await tx
            .update(signingKeys)
            .set({ status: 'retired', retiredAt: at, updatedAt: at })
            .where(
              and(
                eq(signingKeys.id, plan.retireId),
                eq(signingKeys.environmentId, environmentId),
                eq(signingKeys.status, 'active')
              )
            )
            .returning({ id: signingKeys.id })
          const activated = await tx
            .update(signingKeys)
            .set({ status: 'active', activatedAt: at, updatedAt: at })
            .where(
              and(
                eq(signingKeys.id, plan.activateId),
                eq(signingKeys.environmentId, environmentId),
                eq(signingKeys.status, 'next')
              )
            )
            .returning({ id: signingKeys.id })
          if (retired.length !== 1 || activated.length !== 1) {
            throw new LostRace()
          }
          await tx.insert(signingKeys).values(toValues(environmentId, plan.next))
        })
        return true
      } catch (error) {
        if (error instanceof LostRace || isUniqueViolation(error)) {
          return false
        }
        throw error
      }
    },
  }
}
