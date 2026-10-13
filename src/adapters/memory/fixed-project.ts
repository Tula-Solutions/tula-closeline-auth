import {
  type EnvironmentKind,
  type FixedProject,
  type FixedProjectIds,
  FixedProjectViolation,
  type Tenant,
} from '~/ports/fixed-project'

/** The fixed project in memory, for tests. `plant` stands in for rows put there by someone else. */
export function createMemoryFixedProject(): FixedProject & {
  /** Rows the service did not create, to prove it refuses a second project. */
  plant: (extra: { workspaces?: number; projects?: number }) => void
} {
  let state: { projectId: string; environments: Record<EnvironmentKind, string> } | undefined
  let extraWorkspaces = 0
  let extraProjects = 0
  return {
    plant(extra) {
      extraWorkspaces += extra.workspaces ?? 0
      extraProjects += extra.projects ?? 0
    },
    async ensure(kind: EnvironmentKind, ids: FixedProjectIds): Promise<Tenant> {
      // No await between the check and the write: calls take turns, as the Postgres lock makes them.
      if (extraWorkspaces + (state ? 1 : 0) > 1 || extraProjects + (state ? 1 : 0) > 1) {
        throw new FixedProjectViolation(
          'this Region already has more than one workspace or project'
        )
      }
      state ??= {
        projectId: ids.project,
        environments: { development: ids.development, production: ids.production },
      }
      return { projectId: state.projectId, environmentId: state.environments[kind] }
    },
  }
}
