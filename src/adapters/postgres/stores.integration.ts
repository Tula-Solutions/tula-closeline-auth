import { afterAll, beforeAll } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { describeFlowAttemptStore } from '~/adapters/flow-attempt-store.suite'
import { PostgresFlowAttemptStore } from '~/adapters/postgres/flow-attempts'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { sessionStoreSuite } from '~/adapters/session-store.suite'
import { userRepositorySuite } from '~/adapters/user-repository.suite'
import { describeVerificationTokenStore } from '~/adapters/verification-token-store.suite'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'
import { integrationTenants } from '~/testing/tenant'

const owner = ownerPool()
const handle = createDb(authUrl())
const { db } = handle

beforeAll(migrate)
afterAll(async () => {
  await handle.close()
  await owner.end()
})

describeFlowAttemptStore('PostgresFlowAttemptStore on a real server', async () => {
  await resetAuthData(owner)
  return { store: new PostgresFlowAttemptStore(db), ...(await integrationTenants(db)) }
})

describeVerificationTokenStore('PostgresVerificationTokenStore on a real server', async () => {
  await resetAuthData(owner)
  return { store: new PostgresVerificationTokenStore(db), ...(await integrationTenants(db)) }
})

userRepositorySuite('PostgresUserRepository on a real server', async () => {
  await resetAuthData(owner)
  return { users: new PostgresUserRepository(db), ...(await integrationTenants(db)) }
})

sessionStoreSuite('PostgresSessionStore on a real server', async () => {
  await resetAuthData(owner)
  return { store: new PostgresSessionStore(db), ...(await integrationTenants(db)) }
})
