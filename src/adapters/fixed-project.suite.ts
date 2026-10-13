import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type FixedProject,
  type FixedProjectIds,
  FixedProjectViolation,
} from '~/ports/fixed-project'

/** What a behaviour suite needs from an adapter under test. */
export type FixedProjectHarness = {
  adapter: FixedProject
  /** Puts a second project (and so a second workspace) where the service did not. */
  plantSecondProject: () => Promise<void>
}

const NOW = new Date('2026-01-01T00:00:00Z')

function idsOf(n: number): FixedProjectIds {
  const id = (k: number) => `00000000-0000-7000-8000-${String(n * 10 + k).padStart(12, '0')}`
  return { workspace: id(1), project: id(2), development: id(3), production: id(4) }
}

/** The behaviour every FixedProject adapter has, memory included (one suite, each adapter). */
export function fixedProjectSuite(name: string, make: () => Promise<FixedProjectHarness>): void {
  describe(`${name} fixed project`, () => {
    let harness: FixedProjectHarness
    beforeEach(async () => {
      harness = await make()
    })

    test('refuses to run when the Region already holds a second project', async () => {
      await harness.adapter.ensure('development', idsOf(1), NOW)
      await harness.plantSecondProject()

      await expect(harness.adapter.ensure('development', idsOf(2), NOW)).rejects.toBeInstanceOf(
        FixedProjectViolation
      )
    })

    test('creates the project once and returns it again on every later call', async () => {
      const first = await harness.adapter.ensure('development', idsOf(1), NOW)
      const second = await harness.adapter.ensure('development', idsOf(2), NOW)

      expect(second).toEqual(first)
      expect(first.projectId).toBe(idsOf(1).project)
      expect(first.environmentId).toBe(idsOf(1).development)
    })

    test('gives the development and production environments of the one project', async () => {
      const development = await harness.adapter.ensure('development', idsOf(1), NOW)
      const production = await harness.adapter.ensure('production', idsOf(2), NOW)

      expect(production.projectId).toBe(development.projectId)
      expect(production.environmentId).not.toBe(development.environmentId)
      expect(production.environmentId).toBe(idsOf(1).production)
    })

    test('many instances starting together all get the same tenant', async () => {
      const tenants = await Promise.all(
        Array.from({ length: 12 }, (_, n) =>
          harness.adapter.ensure(n % 2 === 0 ? 'development' : 'production', idsOf(n + 1), NOW)
        )
      )

      expect(new Set(tenants.map((tenant) => tenant.projectId)).size).toBe(1)
      expect(new Set(tenants.map((tenant) => tenant.environmentId)).size).toBe(2)
    })
  })
}
