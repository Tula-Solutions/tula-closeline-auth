import { afterAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { formatId } from 'tula-closeline-contract'
import { type FakeCore, startFakeCore } from '~/testing/fake-core'
import { createHttpMembership } from './membership'

const cores: FakeCore[] = []
const servers: Server[] = []
afterAll(async () => {
  await Promise.all(cores.map((core) => core.stop()))
  for (const server of servers) {
    server.close()
  }
})

const user = () => formatId('usr', crypto.randomUUID())

/** Every operation of the adapter, as a function of an adapter. */
const OPERATIONS = {
  lookup: (adapter: ReturnType<typeof createHttpMembership>) => adapter.forUser(user()),
  createOrganization: (adapter: ReturnType<typeof createHttpMembership>) =>
    adapter.createOrganization({
      email: 'maya@northline.app',
      memberName: null,
      userId: user(),
      name: 'Northline',
      idempotencyKey: crypto.randomUUID(),
    }),
  acceptInvitation: (adapter: ReturnType<typeof createHttpMembership>) =>
    adapter.acceptInvitation({
      email: 'rep@example.com',
      memberName: null,
      userId: user(),
      invitationToken: `inv-${'z'.repeat(30)}`,
      idempotencyKey: crypto.randomUUID(),
    }),
  abandon: (adapter: ReturnType<typeof createHttpMembership>) =>
    adapter.abandonOrganization({
      organizationId: formatId('org', crypto.randomUUID()),
      userId: user(),
      idempotencyKey: crypto.randomUUID(),
    }),
} as const

/** What one failing call costs, per operation: the adapter's one retry of a read, nothing else. */
const EXPECTED_ATTEMPTS = {
  lookup: 2,
  createOrganization: 1,
  acceptInvitation: 1,
  abandon: 1,
} as const

/** A TCP server that counts connections and closes each at once, so every attempt fails. */
async function startDroppingServer(): Promise<{ url: string; connections: () => number }> {
  let count = 0
  const server = createServer((socket) => {
    count += 1
    socket.destroy()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('no port')
  }
  return { url: `http://127.0.0.1:${address.port}`, connections: () => count }
}

describe('how many times a failing call is attempted', () => {
  test.each(Object.keys(OPERATIONS) as (keyof typeof OPERATIONS)[])(
    '%s: a 5xx from core is attempted the expected number of times, once per layer',
    async (name) => {
      const core = startFakeCore()
      cores.push(core)
      core.script(
        ...Array.from({ length: 6 }, () => ({ kind: 'json', status: 500, body: {} }) as const)
      )
      const adapter = createHttpMembership({
        baseUrl: core.url,
        token: core.secret,
        environment: 'local',
        retryDelayMs: () => 0,
      })

      await expect(OPERATIONS[name](adapter)).rejects.toBeDefined()

      expect(core.requests).toHaveLength(EXPECTED_ATTEMPTS[name])
    }
  )

  test.each(Object.keys(OPERATIONS) as (keyof typeof OPERATIONS)[])(
    '%s: a connection that fails is attempted the expected number of times',
    async (name) => {
      const dropping = await startDroppingServer()
      const adapter = createHttpMembership({
        baseUrl: dropping.url,
        token: 'x'.repeat(40),
        environment: 'local',
        retryDelayMs: () => 0,
      })

      await expect(OPERATIONS[name](adapter)).rejects.toBeDefined()

      expect(dropping.connections()).toBe(EXPECTED_ATTEMPTS[name])
    }
  )

  test.each([429, 502, 503, 504])(
    'a lookup answered %s is attempted twice, not four times (no second retry layer)',
    async (status) => {
      const core = startFakeCore()
      cores.push(core)
      core.script(...Array.from({ length: 6 }, () => ({ kind: 'json', status, body: {} }) as const))
      const adapter = createHttpMembership({
        baseUrl: core.url,
        token: core.secret,
        environment: 'local',
        retryDelayMs: () => 0,
      })

      await expect(adapter.forUser(user())).rejects.toBeDefined()

      expect(core.requests).toHaveLength(status === 429 ? 1 : 2)
    }
  )
})
