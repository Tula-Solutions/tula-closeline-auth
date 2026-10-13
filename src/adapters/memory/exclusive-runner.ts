import type { ExclusiveRunner } from '~/ports/exclusive-runner'

/** The exclusive runner for one process, for tests: a name is held while its work runs. */
export function createMemoryExclusiveRunner(): ExclusiveRunner {
  const held = new Set<string>()
  return {
    async runExclusive(name, work) {
      if (held.has(name)) {
        return false
      }
      held.add(name)
      try {
        await work()
        return true
      } finally {
        held.delete(name)
      }
    },
  }
}
