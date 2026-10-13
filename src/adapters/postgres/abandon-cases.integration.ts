import { afterAll, beforeAll } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { describeAbandonCases } from '~/adapters/abandon-cases.suite'
import { createPostgresAbandonCases } from '~/adapters/postgres/abandon-cases'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'
import { integrationTenants } from '~/testing/tenant'

const owner = ownerPool()
const handle = createDb(authUrl())
const { db } = handle

beforeAll(migrate)
afterAll(async () => {
  await handle.close()
  await owner.end()
})

/** Moves a whole environment's cases back in time as the owner, with the environment set. */
async function age(environmentId: string, seconds: number): Promise<void> {
  const client = await owner.connect()
  try {
    await client.query('begin')
    await client.query('select set_config($1, $2, true)', ['tula.environment_id', environmentId])
    await client.query(
      `update auth.abandon_cases
          set attempt_expires_at = attempt_expires_at - make_interval(secs => $1::float8),
              next_attempt_at = next_attempt_at - make_interval(secs => $1::float8),
              resolved_at = resolved_at - make_interval(secs => $1::float8)`,
      [seconds]
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

describeAbandonCases('PostgresAbandonCases on a real server', async () => {
  await resetAuthData(owner)
  const { a, b } = await integrationTenants(db)
  return {
    store: createPostgresAbandonCases(db),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
    now: () => new Date(),
    age,
  }
})
