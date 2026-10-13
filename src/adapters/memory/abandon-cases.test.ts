import { createFixedClock } from 'tula-closeline-kit'
import { describeAbandonCases } from '~/adapters/abandon-cases.suite'
import { createMemoryAbandonCases } from '~/adapters/memory/abandon-cases'

describeAbandonCases('memory', async () => {
  const clock = createFixedClock('2026-01-01T00:00:00Z')
  return {
    store: createMemoryAbandonCases(clock),
    a: { projectId: 'p', environmentId: 'env-a' },
    b: { projectId: 'p', environmentId: 'env-b' },
    now: () => clock.now(),
    age: async (_environmentId, seconds) => {
      clock.advance(`${Math.round(seconds * 1000)}ms`)
    },
  }
})
