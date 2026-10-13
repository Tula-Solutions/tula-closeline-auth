/** The two environments a project has; a deployment serves one of them (see `~/env`). */
export type EnvironmentKind = 'development' | 'production'

/** Where this deployment's data lives: its one project and the environment it serves. */
export type Tenant = {
  projectId: string
  environmentId: string
}

/** The ids to use if the fixed project does not exist yet; ignored when it does. */
export type FixedProjectIds = {
  workspace: string
  project: string
  development: string
  production: string
}

/** Thrown when the data holds more than one workspace or project: this Region has exactly one. */
export class FixedProjectViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FixedProjectViolation'
  }
}

/**
 * The one workspace and one project of this Region (ADR 0005), with their environments. This is
 * the only code in the service that creates either; nothing else may.
 */
export interface FixedProject {
  /**
   * Make sure exactly one workspace, one project and both environments exist, creating whichever
   * is missing, and return the tenant of the environment of `kind`. Safe to call from any number
   * of instances at once: the writers take turns, so the outcome is the same as one call.
   *
   * @param kind - The environment this deployment serves.
   * @param ids - The ids to create with.
   * @param now - The creation time.
   * @throws FixedProjectViolation when there is already more than one workspace or project.
   */
  ensure(kind: EnvironmentKind, ids: FixedProjectIds, now: Date): Promise<Tenant>
}
