import { describe, expect, test } from 'bun:test'
import { FixedProjectViolation } from '~/ports/fixed-project'
import { createTestDeps } from '~/testing'
import * as Bootstrap from './service'

describe('bootstrapping the Region fixed project', () => {
  test('a tenant requested before bootstrapping is an error, not an empty tenant', () => {
    expect(() => Bootstrap.requireTenant(createTestDeps())).toThrow(/not been bootstrapped/)
  })

  test('start remembers the tenant, and starting again returns the same one', async () => {
    const deps = createTestDeps()

    const first = await Bootstrap.start(deps)
    const second = await Bootstrap.start(deps)

    expect(second).toEqual(first)
    expect(Bootstrap.requireTenant(deps)).toEqual(first)
  })

  test.each([
    ['local', 'development'],
    ['dev', 'development'],
    ['staging', 'development'],
    ['prod', 'production'],
  ] as const)('a %s deployment serves the %s environment', (environment, kind) => {
    expect(Bootstrap.environmentKindFor(environment)).toBe(kind)
  })

  test('a Region that already has two projects is refused and no tenant is remembered', async () => {
    const deps = createTestDeps()
    ;(deps.fixedProject as unknown as { plant: (n: object) => void }).plant({ projects: 2 })

    await expect(Bootstrap.start(deps)).rejects.toBeInstanceOf(FixedProjectViolation)
    expect(deps.tenant.current).toBeUndefined()
  })
})
