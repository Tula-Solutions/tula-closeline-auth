import { formatId } from 'tula-closeline-contract'
import {
  ABANDON_CLAIM,
  ABANDON_GIVE_UP_SPENT,
  ABANDON_LEARN,
  ABANDON_PURGE_BATCH,
  ABANDON_RECORD,
  ABANDON_RESOLVE,
  type Database,
  withEnvironment,
} from 'tula-closeline-db'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import { statement } from '~/adapters/postgres/statement'
import type {
  AbandonCaseStore,
  AbandonOutcome,
  ClaimedAbandonCase,
  LearnResult,
  NewAbandonCase,
} from '~/ports/abandon-cases'

/** The `org_` id as the bare uuid the column holds (Postgres reads 32 hex characters as a uuid). */
export function bareId(id: string): string {
  return id.slice(id.indexOf('_') + 1)
}

type ClaimRow = {
  id: string
  core_organization_id: string | null
  user_id: string
  attempt_id: string
  attempts: number
}

/** The abandon cases in `auth.abandon_cases`, every statement inside the environment's RLS scope. */
export function createPostgresAbandonCases(db: Database): AbandonCaseStore {
  return {
    async record(input: NewAbandonCase) {
      const rows = await withEnvironment(db, input.environmentId, async (tx) => {
        const result = await tx.execute(
          statement(ABANDON_RECORD, [
            input.id,
            input.projectId,
            input.environmentId,
            input.organizationId === null ? null : bareId(input.organizationId),
            input.userId,
            input.attemptId,
            input.attemptExpiresAt,
            input.graceMs,
          ])
        )
        return result.rows
      })
      return rows.length > 0
    },

    async learn(environmentId, id, organizationId): Promise<LearnResult> {
      try {
        const rows = await withEnvironment(db, environmentId, async (tx) => {
          const result = await tx.execute(
            statement(ABANDON_LEARN, [id, environmentId, bareId(organizationId)])
          )
          return result.rows
        })
        return rows.length > 0 ? 'learned' : 'unchanged'
      } catch (error) {
        if (isUniqueViolation(error)) {
          return 'conflict'
        }
        throw error
      }
    },

    async claim(environmentId, limit, leaseMs): Promise<ClaimedAbandonCase[]> {
      const rows = await withEnvironment(db, environmentId, async (tx) => {
        const result = await tx.execute<ClaimRow>(
          statement(ABANDON_CLAIM, [environmentId, limit, leaseMs])
        )
        return result.rows
      })
      return rows.map((row) => ({
        id: row.id,
        organizationId:
          row.core_organization_id === null ? null : formatId('org', row.core_organization_id),
        userId: row.user_id,
        attemptId: row.attempt_id,
        attempts: row.attempts,
      }))
    },

    async resolve(environmentId, id, outcome: AbandonOutcome) {
      const rows = await withEnvironment(db, environmentId, async (tx) => {
        const result = await tx.execute(statement(ABANDON_RESOLVE, [id, environmentId, outcome]))
        return result.rows
      })
      return rows.length > 0
    },

    async giveUpSpent(environmentId, limit) {
      const rows = await withEnvironment(db, environmentId, async (tx) => {
        const result = await tx.execute<{ id: string }>(
          statement(ABANDON_GIVE_UP_SPENT, [environmentId, limit])
        )
        return result.rows
      })
      return rows.map((row) => row.id)
    },

    async purgeResolved(environmentId, limit) {
      return await withEnvironment(db, environmentId, async (tx) => {
        const result = await tx.execute(statement(ABANDON_PURGE_BATCH, [environmentId, limit]))
        return result.rowCount ?? 0
      })
    },
  }
}
