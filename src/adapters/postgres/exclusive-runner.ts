import { sql } from 'drizzle-orm'
import type { Database } from 'tula-closeline-db'
import type { ExclusiveRunner } from '~/ports/exclusive-runner'

/**
 * Exclusive work through a Postgres transaction-scoped advisory lock: the lock is taken without
 * waiting, held by one pooled connection while the work runs, and released by Postgres when the
 * transaction ends, so a crashed instance can never leave a name held.
 */
export function createPostgresExclusiveRunner(db: Database): ExclusiveRunner {
  return {
    async runExclusive(name, work) {
      return db.transaction(async (tx) => {
        const result = await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`closeline-auth:${name}`}, 0)) as locked`
        )
        if (result.rows[0]?.locked !== true) {
          return false
        }
        await work()
        return true
      })
    },
  }
}
