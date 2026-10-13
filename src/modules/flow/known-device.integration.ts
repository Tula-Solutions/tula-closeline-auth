import { afterAll } from 'bun:test'
import { createApp } from '~/app'
import { createPostgresDeps, secondInstance } from '~/testing/postgres-deps'
import { describeKnownDevices } from './known-device.suite'

let shared: ReturnType<typeof createPostgresDeps> | undefined

afterAll(async () => {
  await (await shared)?.stop()
})

// Two API instances, each with counter adapters of its own, over one database. Nothing they count
// is held in process memory, so what one counts the other sees.
describeKnownDevices('Postgres, two instances', async () => {
  shared ??= createPostgresDeps()
  const deps = await shared
  return { deps, apps: [createApp(deps), createApp(secondInstance(deps))] }
})
