import type { Container } from '~/container'
import type { EnvironmentKind, Tenant } from '~/ports/fixed-project'

/** What bootstrapping needs from the container. */
export type BootstrapDeps = Pick<Container, 'env' | 'ids' | 'clock' | 'fixedProject' | 'tenant'>

/**
 * The environment this deployment serves: `production` when `ENVIRONMENT` is `prod`, otherwise
 * `development`. A Region's one project has both, and a deployment never serves the other.
 */
export function environmentKindFor(
  environment: BootstrapDeps['env']['ENVIRONMENT']
): EnvironmentKind {
  return environment === 'prod' ? 'production' : 'development'
}

/**
 * Make sure the Region's one workspace, one project and its environments exist, and remember the
 * tenant this deployment serves. Idempotent and safe to run on every instance at once.
 *
 * @throws FixedProjectViolation when the data holds more than one workspace or project.
 */
export async function start(deps: BootstrapDeps): Promise<Tenant> {
  const tenant = await deps.fixedProject.ensure(
    environmentKindFor(deps.env.ENVIRONMENT),
    {
      workspace: deps.ids.next(),
      project: deps.ids.next(),
      development: deps.ids.next(),
      production: deps.ids.next(),
    },
    deps.clock.now()
  )
  deps.tenant.current = tenant
  return tenant
}

/** The tenant a request is served for. Throws if called before {@link start} finished. */
export function requireTenant(deps: Pick<BootstrapDeps, 'tenant'>): Tenant {
  const tenant = deps.tenant.current
  if (!tenant) {
    throw new Error('the fixed project has not been bootstrapped yet')
  }
  return tenant
}
