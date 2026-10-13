import type { Jwk } from '~/modules/jwks/schema'
import {
  canVerify,
  type NewSigningKey,
  type RotationPlan,
  type SigningKeyRecord,
  type SigningKeyStore,
} from '~/ports/signing-key-store'

function copy(record: SigningKeyRecord): SigningKeyRecord {
  return { ...record, publicJwk: { ...record.publicJwk } }
}

/** In-memory signing keys, mirroring the Postgres one-active / one-next constraints. */
export function createMemorySigningKeyStore(): SigningKeyStore {
  const keys: SigningKeyRecord[] = []
  const newestFirst = (a: SigningKeyRecord, b: SigningKeyRecord) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)

  return {
    async verificationKeys(environmentId, now, limit): Promise<Jwk[]> {
      return keys
        .filter((key) => key.environmentId === environmentId && canVerify(key, now))
        .sort(newestFirst)
        .slice(0, limit)
        .map((key) => ({ ...key.publicJwk, kid: key.id }))
    },

    async list(environmentId) {
      return keys
        .filter((key) => key.environmentId === environmentId)
        .sort(newestFirst)
        .map(copy)
    },

    async insert(environmentId, added: NewSigningKey[]) {
      const taken = (status: string) =>
        keys.some((key) => key.environmentId === environmentId && key.status === status)
      const statuses = added.map((key) => key.status)
      const clash =
        statuses.some((status) => status !== 'retired' && taken(status)) ||
        new Set(statuses).size !== statuses.length
      if (clash) {
        return false
      }
      for (const key of added) {
        keys.push(copy({ ...key, environmentId, retiredAt: null }))
      }
      return true
    },

    async rotate(environmentId, plan: RotationPlan, at) {
      const find = (id: string) =>
        keys.find((key) => key.id === id && key.environmentId === environmentId)
      const retiring = find(plan.retireId)
      const activating = find(plan.activateId)
      if (retiring?.status !== 'active' || activating?.status !== 'next') {
        return false
      }
      retiring.status = 'retired'
      retiring.retiredAt = at
      activating.status = 'active'
      activating.activatedAt = at
      keys.push(copy({ ...plan.next, environmentId, retiredAt: null }))
      return true
    },
  }
}
