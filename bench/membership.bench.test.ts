import { afterAll, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createHttpMembership } from '../src/adapters/http/membership'
import { startFakeCore } from '../src/testing/fake-core'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The membership lookup through the HTTP adapter: refresh and sign-in each make one, so every
// signed-in device pays it once a minute. The cost of the adapter itself is O(1) per call: build
// the request, three Zod parses (request, error body, answer), a UUID, `AbortSignal.timeout`, one
// bounded read of the answer and the concurrency slot. Measured against an in-process fake of
// core over the loopback interface, so it times this service's side of the call plus the local
// socket, not a real network or a real core. Typical best batch on a developer laptop:
// 62 ms for 500 lookups (about 0.12 ms each; the median batch was 65 ms, 62 to 64 ms best over
// three runs). The kit client opens a new connection per call, so a connection per lookup is the
// baseline this number includes (the `fetch` adapter it replaced measured 41 ms). It is plain
// http over loopback: no TLS handshake and no DNS.
// The budget is about four times the typical best batch. A regression such as a retry on every
// call or an unbounded read fails it.
const BUDGET_MS = 270

const core = startFakeCore()
afterAll(async () => {
  await core.stop()
})

test(`membership lookup: the best of ${BATCHES} batches of ${BATCH_REQUESTS} lookups is within ${BUDGET_MS} ms`, async () => {
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

  const result = await measure(async () => {
    const found = await adapter.forUser(userId)
    if (found?.role !== 'owner') {
      throw new Error('lookup failed')
    }
  })

  console.log(summary('membership lookup (http adapter)', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
