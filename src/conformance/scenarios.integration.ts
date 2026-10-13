import { afterAll, describe, test } from 'bun:test'
import { createApp } from '~/app'
import { createPostgresDeps } from '~/testing/postgres-deps'
import { loadScenarios } from './load'
import { runScenario } from './runner'

const scenarios = await loadScenarios()
const open: { stop: () => Promise<void> }[] = []

afterAll(async () => {
  for (const deps of open) {
    await deps.stop()
  }
})

describe('conformance scenarios, over real Postgres adapters', () => {
  for (const { file, scenario } of scenarios) {
    test(`${file}: ${scenario.name}`, async () => {
      const deps = await createPostgresDeps()
      open.push(deps)

      await runScenario({ app: createApp(deps), deps }, scenario)
    })
  }
})
