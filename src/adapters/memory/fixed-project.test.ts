import { fixedProjectSuite } from '~/adapters/fixed-project.suite'
import { createMemoryFixedProject } from '~/adapters/memory/fixed-project'

fixedProjectSuite('memory', async () => {
  const adapter = createMemoryFixedProject()
  return {
    adapter,
    plantSecondProject: async () => adapter.plant({ workspaces: 1, projects: 1 }),
    plantExtraEnvironment: async () => adapter.plant({ environments: 1 }),
  }
})
