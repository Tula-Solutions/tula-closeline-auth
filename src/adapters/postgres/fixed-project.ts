import { sql } from 'drizzle-orm'
import type { Database } from 'tula-closeline-db'
import { environments, projects, workspaces } from 'tula-closeline-db/schema'
import {
  type EnvironmentKind,
  type FixedProject,
  type FixedProjectIds,
  FixedProjectViolation,
  type Tenant,
} from '~/ports/fixed-project'

/** The workspace's name; the project's is the same. Not a Closeline domain term (ADR 0005). */
const NAME = 'closeline'

/**
 * The fixed project in Postgres. The writers take turns on a transaction-scoped advisory lock, so
 * of any number of instances starting together exactly one creates the rows and the others read
 * them. The unique key on (project, kind) is the second line of defence for the environments.
 *
 * `withEnvironment` is not used: the three control-plane tables are not under row-level security.
 */
export function createPostgresFixedProject(db: Database): FixedProject {
  return {
    async ensure(kind: EnvironmentKind, ids: FixedProjectIds, now: Date): Promise<Tenant> {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('closeline-auth:fixed-project', 0))`
        )
        const knownWorkspaces = await tx.select({ id: workspaces.id }).from(workspaces).limit(2)
        const knownProjects = await tx.select({ id: projects.id }).from(projects).limit(2)
        if (knownWorkspaces.length > 1 || knownProjects.length > 1) {
          throw new FixedProjectViolation(
            'this Region already has more than one workspace or project'
          )
        }
        let workspaceId = knownWorkspaces[0]?.id
        if (workspaceId === undefined) {
          workspaceId = ids.workspace
          await tx
            .insert(workspaces)
            .values({ id: workspaceId, name: NAME, createdAt: now, updatedAt: now })
        }
        let projectId = knownProjects[0]?.id
        if (projectId === undefined) {
          projectId = ids.project
          await tx
            .insert(projects)
            .values({ id: projectId, workspaceId, name: NAME, createdAt: now, updatedAt: now })
        }
        await tx
          .insert(environments)
          .values([
            { id: ids.development, projectId, kind: 'development', createdAt: now, updatedAt: now },
            { id: ids.production, projectId, kind: 'production', createdAt: now, updatedAt: now },
          ])
          .onConflictDoNothing({ target: [environments.projectId, environments.kind] })
        const [environment] = await tx
          .select({ id: environments.id })
          .from(environments)
          .where(sql`${environments.projectId} = ${projectId} and ${environments.kind} = ${kind}`)
        if (!environment) {
          throw new FixedProjectViolation('the environment could not be created')
        }
        return { projectId, environmentId: environment.id }
      })
    },
  }
}
