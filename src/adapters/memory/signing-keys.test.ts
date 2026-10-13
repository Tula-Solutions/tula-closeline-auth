import { createMemorySigningKeyStore } from '~/adapters/memory/signing-keys'
import { signingKeyStoreSuite } from '~/adapters/signing-key-store.suite'

signingKeyStoreSuite('memory', async () => ({
  store: createMemorySigningKeyStore(),
  environments: [
    { projectId: 'p1', environmentId: 'e1' },
    { projectId: 'p1', environmentId: 'e2' },
  ],
}))
