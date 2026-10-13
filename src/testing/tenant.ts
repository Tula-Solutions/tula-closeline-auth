import { type Database, withEnvironment } from 'tula-closeline-db'
import { flowAttempts, users } from 'tula-closeline-db/schema'
import { createPostgresFixedProject } from '~/adapters/postgres/fixed-project'

/** A tenant for a store suite, plus the rows its foreign keys need. */
export type IntegrationTenant = {
  projectId: string
  environmentId: string
  /** Inserts a user and returns its id. */
  user: () => Promise<string>
  /** Inserts a sign-up flow attempt and returns its id. */
  flowAttempt: () => Promise<string>
}

/** Makes a fixed project (once per call) and returns its development and production tenants. */
export async function integrationTenants(
  db: Database
): Promise<{ a: IntegrationTenant; b: IntegrationTenant }> {
  const id = () => crypto.randomUUID()
  const ids = { workspace: id(), project: id(), development: id(), production: id() }
  const fixed = createPostgresFixedProject(db)
  const development = await fixed.ensure('development', ids, new Date())
  const make = (environmentId: string): IntegrationTenant => ({
    projectId: development.projectId,
    environmentId,
    user: () =>
      withEnvironment(db, environmentId, async (tx) => {
        const userId = Bun.randomUUIDv7()
        await tx
          .insert(users)
          .values({ id: userId, projectId: development.projectId, environmentId })
        return userId
      }),
    flowAttempt: () =>
      withEnvironment(db, environmentId, async (tx) => {
        const attemptId = Bun.randomUUIDv7()
        await tx.insert(flowAttempts).values({
          id: attemptId,
          projectId: development.projectId,
          environmentId,
          kind: 'sign_up',
          status: 'needs_email_verification',
          identifier: 'maya@northline.app',
          expiresAt: new Date('2026-01-01T00:10:00Z'),
        })
        return attemptId
      }),
  })
  return { a: make(ids.development), b: make(ids.production) }
}
