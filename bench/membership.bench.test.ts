import { afterAll, expect, test } from 'bun:test'
import type { Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { formatId, type UserId } from 'tula-closeline-contract'
import { createHttpMembership } from '../src/adapters/http/membership'
import { startFakeCore } from '../src/testing/fake-core'
import { makeTestCert } from '../src/testing/test-cert'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The membership lookup through the HTTP adapter: refresh and sign-in each make one, so every
// signed-in device pays it once a minute. The cost of the adapter itself is O(1) per call: build
// the request, three Zod parses (request, error body, answer), a UUID, `AbortSignal.timeout`, one
// bounded read of the answer and the concurrency slot. Measured against in-process stand-ins for
// core over loopback, so it times this service's side of the call plus the local socket, not a
// real network, DNS, a load balancer or a real core.
//
// Production keeps connections to core alive (hub issue 45), so the gated legs run with
// keep-alive on: plain http (the fake core) and https (a stub with a throwaway certificate, so the
// handshake of a new connection is in the number whenever one is made). The same two legs with
// keep-alive off are timed for reference and not gated: that is what every lookup cost before.
// Typical best batch per 500 lookups on a developer laptop (Bun 1.4.2, three runs):
//   plain http   keep-alive on  ~32 ms    off ~64 ms   (62 ms before keep-alive, budget was 270)
//   https (TLS)  keep-alive on  ~38 ms    off ~540 ms
// The budgets are about 4x the typical best keep-alive batch, so a runner can be slow but a
// regression such as a retry on every call, an unbounded read or a lost connection reuse (the
// https leg would then take ~540 ms) fails them.
const BUDGET_HTTP_MS = 130
const BUDGET_HTTPS_MS = 160

const tlsUser = formatId('usr', crypto.randomUUID())
const core = startFakeCore()
const tlsServers: Server[] = []
const cert = makeTestCert()
afterAll(async () => {
  await core.stop()
  for (const server of tlsServers) {
    server.closeAllConnections()
    server.close()
  }
  cert?.remove()
})

type Leg = { url: string; token: string; userId: UserId; ca?: string }

/** An adapter for a leg; the caller closes it. */
function adapterFor(leg: Leg, keepAlive: boolean) {
  return createHttpMembership({
    baseUrl: leg.url,
    token: leg.token,
    environment: 'local',
    keepAlive,
    ...(leg.ca === undefined ? {} : { ca: leg.ca }),
  })
}

/** Times a leg with keep-alive on, in full: this is the gated number. `userId` is an Owner there. */
async function gatedLeg(label: string, leg: Leg) {
  const adapter = adapterFor(leg, true)
  try {
    const result = await measure(async () => {
      const found = await adapter.forUser(leg.userId)
      if (found?.role !== 'owner') {
        throw new Error('lookup failed')
      }
    })
    console.log(summary(`membership lookup (${label}, keep-alive on)`, result))
    return result
  } finally {
    adapter.close?.()
  }
}

/** Lookups timed for the keep-alive-off reference: few, because each one may do a handshake. */
const REFERENCE_LOOKUPS = 100

/** Times a leg with keep-alive off over {@link REFERENCE_LOOKUPS}, reported per 500; not gated. */
async function referenceLeg(label: string, leg: Leg): Promise<void> {
  const adapter = adapterFor(leg, false)
  try {
    await adapter.forUser(leg.userId)
    const started = performance.now()
    for (let index = 0; index < REFERENCE_LOOKUPS; index++) {
      await adapter.forUser(leg.userId)
    }
    const per500 = ((performance.now() - started) / REFERENCE_LOOKUPS) * BATCH_REQUESTS
    console.log(
      `membership lookup (${label}, keep-alive off): about ${per500.toFixed(1)} ms per ${BATCH_REQUESTS} requests (${REFERENCE_LOOKUPS} timed, not gated)`
    )
  } finally {
    adapter.close?.()
  }
}

/** A stand-in core over TLS that answers every lookup with an Owner. */
async function startTlsCore(): Promise<{ url: string; ca: string }> {
  if (cert === undefined) {
    throw new Error('openssl could not make a certificate')
  }
  const server = createHttpsServer({ cert: cert.cert, key: cert.key }, (request, response) => {
    request.resume()
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        found: true,
        organizationId: formatId('org', crypto.randomUUID()),
        role: 'owner',
        organizationStatus: 'active',
      })
    )
  })
  tlsServers.push(server as unknown as Server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, ca: cert.cert }
}

/** A fake core with one user who is an Owner, for the plain http legs. */
async function seed(): Promise<UserId> {
  const adapter = createHttpMembership({
    baseUrl: core.url,
    token: core.secret,
    environment: 'local',
  })
  const userId = formatId('usr', crypto.randomUUID())
  await adapter.createOrganization({
    email: 'maya@northline.app',
    memberName: null,
    userId,
    name: 'Northline',
    idempotencyKey: crypto.randomUUID(),
  })
  adapter.close?.()
  return userId
}

// Each test sets its own timeout, well above its work (gated legs run 4,000 lookups: under 1 s
// locally, several seconds on a slow runner), because Bun's default of 5 s is not headroom.
const GATED_TIMEOUT_MS = 60_000
const REFERENCE_TIMEOUT_MS = 60_000

test(
  `membership lookup over http: the best of ${BATCHES} batches of ${BATCH_REQUESTS} lookups is within ${BUDGET_HTTP_MS} ms`,
  async () => {
    const userId = await seed()
    const on = await gatedLeg('http', { url: core.url, token: core.secret, userId })
    expect(on.bestMs).toBeLessThan(BUDGET_HTTP_MS)
  },
  GATED_TIMEOUT_MS
)

test(
  `membership lookup over https: the best of ${BATCHES} batches of ${BATCH_REQUESTS} lookups is within ${BUDGET_HTTPS_MS} ms`,
  async () => {
    if (cert === undefined) {
      console.log('membership lookup over https: skipped, openssl could not make a certificate')
      return
    }
    const tls = await startTlsCore()
    const on = await gatedLeg('https', { ...tls, token: 'k'.repeat(40), userId: tlsUser })
    expect(on.bestMs).toBeLessThan(BUDGET_HTTPS_MS)
  },
  GATED_TIMEOUT_MS
)

test(
  'membership lookup, keep-alive off (reference, not gated)',
  async () => {
    const userId = await seed()
    await referenceLeg('http', { url: core.url, token: core.secret, userId })
    if (cert === undefined) {
      return
    }
    const tls = await startTlsCore()
    await referenceLeg('https', { ...tls, token: 'k'.repeat(40), userId: tlsUser })
  },
  REFERENCE_TIMEOUT_MS
)
