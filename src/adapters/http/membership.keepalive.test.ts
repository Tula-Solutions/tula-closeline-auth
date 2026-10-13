import { afterAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { formatId } from 'tula-closeline-contract'
import { createHttpMembership, type HttpMembershipOptions } from './membership'

const servers: Server[] = []
const adapters: { close?: () => void }[] = []
afterAll(() => {
  for (const adapter of adapters) {
    adapter.close?.()
  }
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
})

const user = () => formatId('usr', crypto.randomUUID())

type Stub = { url: string; sockets: Socket[]; requests: () => number }

/**
 * A stand-in core that answers every lookup "no membership" and records each connection.
 * `closeAfterAnswer` closes the connection right after it answers, like a server whose idle
 * timeout is shorter than the client's.
 */
async function startStub(closeAfterAnswer = false): Promise<Stub> {
  const sockets: Socket[] = []
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    requests += 1
    response.setHeader('content-type', 'application/json')
    response.end('{"found":false}', () => {
      if (closeAfterAnswer) {
        request.socket.destroy()
      }
    })
  })
  server.on('connection', (socket) => sockets.push(socket))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('no port')
  }
  return { url: `http://127.0.0.1:${address.port}`, sockets, requests: () => requests }
}

function connect(stub: Stub, options: Partial<HttpMembershipOptions> = {}) {
  const adapter = createHttpMembership({
    baseUrl: stub.url,
    token: 'k'.repeat(40),
    environment: 'local',
    retryDelayMs: () => 0,
    ...options,
  })
  adapters.push(adapter)
  return adapter
}

describe('membership lookup keeps its connection', () => {
  test('sequential lookups reuse one connection', async () => {
    const stub = await startStub()
    const adapter = connect(stub)

    for (let index = 0; index < 10; index++) {
      expect(await adapter.forUser(user())).toBeNull()
    }

    expect(stub.requests()).toBe(10)
    expect(stub.sockets).toHaveLength(1)
  })

  test('a core that closes the connection after each answer never fails a lookup', async () => {
    const stub = await startStub(true)
    const adapter = connect(stub)

    for (let index = 0; index < 10; index++) {
      expect(await adapter.forUser(user())).toBeNull()
    }

    expect(stub.requests()).toBeGreaterThanOrEqual(10)
  })

  test('a core that closes an idle connection between lookups does not fail the next one', async () => {
    const stub = await startStub()
    const adapter = connect(stub)
    await adapter.forUser(user())

    for (const socket of stub.sockets) {
      socket.destroy()
    }
    await Bun.sleep(5)

    expect(await adapter.forUser(user())).toBeNull()
    expect(stub.sockets.length).toBeGreaterThanOrEqual(2)
  })

  test('close ends the connections it holds, and a later call fails instead of reconnecting', async () => {
    const stub = await startStub()
    const adapter = connect(stub)
    await adapter.forUser(user())
    const [socket] = stub.sockets
    expect(socket?.destroyed).toBe(false)

    adapter.close?.()
    await Bun.sleep(20)

    expect(socket?.destroyed).toBe(true)
    await expect(adapter.forUser(user())).rejects.toThrow()
    expect(stub.sockets).toHaveLength(1)
  })

  test('a lookup is sent again at most once after a stale connection, never more', async () => {
    const stub = await startStub()
    const adapter = connect(stub, { lookupTimeoutMs: 500 })
    await adapter.forUser(user())
    // Every connection the stub ever sees from now on is dropped at once.
    const server = servers[servers.length - 1]
    server?.on('connection', (socket) => socket.destroy())
    for (const socket of stub.sockets) {
      socket.destroy()
    }
    await Bun.sleep(5)

    await expect(adapter.forUser(user())).rejects.toThrow()

    expect(stub.requests()).toBe(1)
  })

  test('a write is never sent twice by the adapter on a stale connection', async () => {
    const stub = await startStub()
    const adapter = connect(stub)
    await adapter.forUser(user())
    const server = servers[servers.length - 1]
    server?.on('connection', (socket) => socket.destroy())
    for (const socket of stub.sockets) {
      socket.destroy()
    }
    await Bun.sleep(5)
    const before = stub.sockets.length

    await expect(
      adapter.createOrganization({
        email: 'maya@northline.app',
        memberName: null,
        userId: user(),
        name: 'Northline',
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow()

    // One attempt: the flow retries a write under its own key, the adapter does not.
    expect(stub.sockets.length - before).toBeLessThanOrEqual(1)
  })
})
